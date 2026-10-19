import express from 'express';
import crypto from 'node:crypto';
import { db } from './db.js';
import { addClient, commandClock, commandsSince } from './hub.js';

// 키오스크 단말이 호출하는 공개 API (읽기 전용 설정 + 상태 보고)
const router = express.Router();

const getKiosk = (code) => db.prepare('SELECT * FROM kiosks WHERE code=?').get(code);

function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function buildConfig(kiosk) {
  const buildingFilter = kiosk.show_all_buildings || !kiosk.building_id ? '' : 'WHERE id=@bid';
  const buildings = db.prepare(`SELECT id, name, name_en, code, description, address FROM buildings ${buildingFilter} ORDER BY sort_order, id`).all({ bid: kiosk.building_id });
  const floorStmt = db.prepare('SELECT id, name, level, description, description_en, map_image FROM floors WHERE building_id=? ORDER BY level DESC, sort_order');
  const facStmt = db.prepare(`SELECT f.id, f.name, f.name_en, f.category_id, c.name category, c.name_en category_en, c.icon category_icon, f.room_no, f.description, f.description_en, f.phone, f.hours, f.hours_rule, f.keywords, f.pos_x, f.pos_y
    FROM facilities f LEFT JOIN categories c ON c.id=f.category_id WHERE f.floor_id=? ORDER BY f.sort_order, f.name`);
  for (const b of buildings) {
    b.floors = floorStmt.all(b.id);
    for (const f of b.floors) f.facilities = facStmt.all(f.id).map((x) => ({ ...x, hours_rule: x.hours_rule ? JSON.parse(x.hours_rule) : null }));
  }

  const today = localStamp().slice(0, 10);
  // 기간이 끝난 항목은 서버에서 거르고, 시간대/요일 조건은 단말이 매 순환마다 판단한다.
  const playlist = kiosk.playlist_id
    ? db.prepare(`SELECT i.id, i.media_id, i.duration, i.muted, i.start_date, i.end_date, i.start_time, i.end_time, i.weekdays,
          m.filename, m.type, m.title
        FROM playlist_items i JOIN media m ON m.id=i.media_id
        WHERE i.playlist_id=? AND i.enabled=1 AND (i.end_date IS NULL OR i.end_date >= ?)
        ORDER BY i.sort_order, i.id`).all(kiosk.playlist_id, today)
    : [];
  const transition = kiosk.playlist_id ? db.prepare('SELECT transition FROM playlists WHERE id=?').get(kiosk.playlist_id)?.transition : 'slide';

  const inList = (csv, id) => String(csv || '').split(',').map(Number).includes(id);
  const notices = db.prepare(`SELECT id, title, body, target_type, target_ids, start_at, end_at FROM notices
      WHERE active=1 AND (end_at IS NULL OR end_at > ?) ORDER BY sort_order, id DESC`).all(localStamp())
    .filter((n) => n.target_type === 'all' || (n.target_type === 'building' && inList(n.target_ids, kiosk.building_id)) || (n.target_type === 'kiosk' && inList(n.target_ids, kiosk.id)))
    .map(({ target_type, target_ids, ...n }) => n);

  const config = {
    kiosk: {
      id: kiosk.id,
      name: kiosk.name,
      code: kiosk.code,
      location: kiosk.location,
      building_id: kiosk.building_id,
      floor_id: kiosk.floor_id,
      pos_x: kiosk.pos_x,
      pos_y: kiosk.pos_y,
      mode: kiosk.mode,
      image_duration: 5, // 사진 기본 노출 시간(재생목록 항목별로 따로 지정 가능)
      idle_timeout: kiosk.idle_timeout || 30,
      enabled: !!kiosk.enabled,
    },
    transition: transition || 'slide',
    playlist,
    // 분류 버튼 순서(관리자가 정함). 시설이 없는 분류는 키오스크에서 숨긴다.
    categories: db.prepare('SELECT id, name, name_en, icon FROM categories ORDER BY sort_order, id').all(),
    buildings,
    notices,
  };
  config.version = crypto.createHash('sha1').update(JSON.stringify(config)).digest('hex').slice(0, 12);
  return config;
}

router.get('/:code/config', (req, res) => {
  const kiosk = getKiosk(req.params.code);
  if (!kiosk) return res.status(404).json({ error: 'unregistered', code: req.params.code });
  res.setHeader('Cache-Control', 'no-store');
  // command_clock: 처음 켜진 키오스크가 이전에 보낸 원격 명령을 다시 실행하지 않도록 기준점을 알려준다.
  res.json({ ...buildConfig(kiosk), command_clock: commandClock() });
});

// SSE 가 막힌 환경(일부 프록시·임시 터널)용: 키오스크가 주기적으로 설정 버전과 밀린 원격 명령을 확인한다.
router.get('/:code/poll', (req, res) => {
  const kiosk = getKiosk(req.params.code);
  if (!kiosk) return res.status(404).json({ error: 'unregistered' });
  db.prepare("UPDATE kiosks SET last_seen=datetime('now'), last_ip=? WHERE id=?").run(req.ip, kiosk.id);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ version: buildConfig(kiosk).version, commands: commandsSince(kiosk.code, Number(req.query.since) || 0) });
});

router.get('/:code/events', (req, res) => {
  const kiosk = getKiosk(req.params.code);
  if (!kiosk) return res.status(404).end();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 5000\nevent: hello\ndata: {}\n\n');
  const remove = addClient(kiosk.code, res);
  db.prepare("UPDATE kiosks SET last_seen=datetime('now'), last_ip=? WHERE id=?").run(req.ip, kiosk.id);
  req.on('close', remove);
});

router.post('/:code/heartbeat', express.json({ limit: '16kb' }), (req, res) => {
  const kiosk = getKiosk(req.params.code);
  if (!kiosk) return res.status(404).json({ error: 'unregistered' });
  const s = req.body || {};
  const status = {
    mode: String(s.mode || '').slice(0, 20),
    current: String(s.current || '').slice(0, 120),
    version: String(s.version || '').slice(0, 20),
    screen: String(s.screen || '').slice(0, 20),
    uptime: Number(s.uptime) || 0,
    errors: Number(s.errors) || 0,
    ua: String(req.headers['user-agent'] || '').slice(0, 200),
  };
  db.prepare("UPDATE kiosks SET last_seen=datetime('now'), last_ip=?, last_status=? WHERE id=?").run(req.ip, JSON.stringify(status), kiosk.id);
  res.json({ ok: true });
});

// 키오스크 API 아래의 없는 경로는 관리자 API로 넘기지 않는다.
router.use((req, res) => res.status(404).json({ error: 'not found' }));

export default router;
