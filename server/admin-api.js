import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, UPLOAD_DIR } from './db.js';
import { login, logout, requireAdmin } from './auth.js';
import { notifyConfigChanged, send, sendCommand, isConnected } from './hub.js';
import { normalizeRule, parseHoursText } from '../public/shared/hours.js';
import { ICONS } from '../public/shared/icons.js';

const router = express.Router();

// ---------- 공통 유틸 ----------
const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const VIDEO_MIMES = ['video/mp4', 'video/webm', 'video/ogg'];

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 6);
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = req.path.endsWith('/map') ? IMAGE_MIMES : [...IMAGE_MIMES, ...VIDEO_MIMES];
    if (!allowed.includes(file.mimetype)) return cb(Object.assign(new Error(`지원하지 않는 파일 형식: ${file.mimetype}`), { status: 400 }));
    // multer 는 originalname 을 latin1 로 디코딩하므로 한글 파일명을 복원한다.
    file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, true);
  },
});

/** body 에서 허용된 필드만 꺼내고 빈 문자열은 NULL 로 바꾼다. */
function pick(body, fields) {
  const out = {};
  for (const f of fields) {
    if (body[f] === undefined) continue;
    let v = body[f];
    if (v === '') v = null;
    if (typeof v === 'boolean') v = v ? 1 : 0;
    out[f] = v;
  }
  return out;
}

function insert(table, data) {
  const keys = Object.keys(data);
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((k) => '@' + k).join(',')})`;
  return db.prepare(sql).run(data).lastInsertRowid;
}

function update(table, id, data) {
  const keys = Object.keys(data);
  if (!keys.length) return db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE id=?`).get(id).c;
  return db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k}=@${k}`).join(',')} WHERE id=@__id`).run({ ...data, __id: id }).changes;
}

function removeFile(filename) {
  if (!filename) return;
  fs.rm(path.join(UPLOAD_DIR, path.basename(filename)), { force: true }, () => {});
}

const need = (cond, msg) => {
  if (!cond) throw Object.assign(new Error(msg), { status: 400 });
};
const found = (row, what = '항목') => {
  if (!row) throw Object.assign(new Error(`${what}을(를) 찾을 수 없습니다.`), { status: 404 });
  return row;
};

// ---------- 인증 ----------
router.post('/auth/login', express.json(), login);
router.post('/auth/logout', logout);
router.use(requireAdmin);
router.get('/auth/me', (req, res) => res.json({ ok: true }));

// 변경 요청이 성공하면 모든 키오스크에 설정 재조회를 알린다.
router.use((req, res, next) => {
  if (req.method !== 'GET') {
    res.on('finish', () => {
      if (res.statusCode < 400) notifyConfigChanged();
    });
  }
  next();
});

const ONLINE_WINDOW_SEC = 90;
const kioskStatus = (k) => {
  const seenAgo = k.last_seen ? (Date.now() - Date.parse(k.last_seen + 'Z')) / 1000 : null;
  return {
    ...k,
    last_status: k.last_status ? JSON.parse(k.last_status) : null,
    connected: isConnected(k.code),
    online: isConnected(k.code) || (seenAgo !== null && seenAgo < ONLINE_WINDOW_SEC),
  };
};

// ---------- 건물(동) ----------
const BUILDING_FIELDS = ['name', 'name_en', 'code', 'description', 'address', 'sort_order'];

router.get('/buildings', (req, res) => {
  res.json(
    db.prepare(`SELECT b.*,
      (SELECT COUNT(*) FROM floors f WHERE f.building_id=b.id) floor_count,
      (SELECT COUNT(*) FROM facilities x JOIN floors f ON f.id=x.floor_id WHERE f.building_id=b.id) facility_count,
      (SELECT COUNT(*) FROM kiosks k WHERE k.building_id=b.id) kiosk_count
      FROM buildings b ORDER BY sort_order, id`).all()
  );
});

router.post('/buildings', express.json(), (req, res) => {
  const data = pick(req.body, BUILDING_FIELDS);
  need(data.name, '동 이름을 입력하세요.');
  const id = insert('buildings', data);
  res.status(201).json({ id });
});

router.put('/buildings/order', express.json(), (req, res) => {
  const stmt = db.prepare('UPDATE buildings SET sort_order=? WHERE id=?');
  db.transaction((ids) => ids.forEach((id, i) => stmt.run(i, id)))(req.body.ids || []);
  res.json({ ok: true });
});

router.put('/buildings/:id', express.json(), (req, res) => {
  found(update('buildings', req.params.id, pick(req.body, BUILDING_FIELDS)), '건물');
  res.json({ ok: true });
});

router.delete('/buildings/:id', (req, res) => {
  const b = found(db.prepare('SELECT * FROM buildings WHERE id=?').get(req.params.id), '건물');
  const maps = db.prepare('SELECT map_image FROM floors WHERE building_id=?').all(b.id);
  db.prepare('DELETE FROM buildings WHERE id=?').run(b.id);
  maps.forEach((m) => removeFile(m.map_image));
  res.json({ ok: true });
});

/** 동 → 층 → 시설 트리 */
router.get('/buildings/:id/tree', (req, res) => {
  const building = found(db.prepare('SELECT * FROM buildings WHERE id=?').get(req.params.id), '건물');
  const floors = db.prepare('SELECT * FROM floors WHERE building_id=? ORDER BY level DESC, sort_order').all(building.id);
  const facStmt = db.prepare(`SELECT f.*, c.name category FROM facilities f LEFT JOIN categories c ON c.id=f.category_id
    WHERE f.floor_id=? ORDER BY f.sort_order, f.name`);
  for (const f of floors) f.facilities = facStmt.all(f.id);
  res.json({ ...building, floors });
});

// ---------- 층 ----------
const FLOOR_FIELDS = ['name', 'level', 'description', 'description_en', 'sort_order'];

router.post('/buildings/:id/floors', express.json(), (req, res) => {
  found(db.prepare('SELECT id FROM buildings WHERE id=?').get(req.params.id), '건물');
  const data = pick(req.body, FLOOR_FIELDS);
  need(data.name, '층 이름을 입력하세요.');
  const id = insert('floors', { ...data, building_id: req.params.id });
  res.status(201).json({ id });
});

router.put('/floors/:id', express.json(), (req, res) => {
  found(update('floors', req.params.id, pick(req.body, FLOOR_FIELDS)), '층');
  res.json({ ok: true });
});

router.delete('/floors/:id', (req, res) => {
  const f = found(db.prepare('SELECT * FROM floors WHERE id=?').get(req.params.id), '층');
  db.prepare('DELETE FROM floors WHERE id=?').run(f.id);
  removeFile(f.map_image);
  res.json({ ok: true });
});

router.post('/floors/:id/map', upload.single('file'), (req, res) => {
  const f = db.prepare('SELECT * FROM floors WHERE id=?').get(req.params.id);
  if (!f) {
    if (req.file) removeFile(req.file.filename);
    return res.status(404).json({ error: '층을 찾을 수 없습니다.' });
  }
  need(req.file, '도면 이미지를 첨부하세요.');
  db.prepare('UPDATE floors SET map_image=? WHERE id=?').run(req.file.filename, f.id);
  removeFile(f.map_image);
  res.json({ map_image: req.file.filename });
});

router.delete('/floors/:id/map', (req, res) => {
  const f = found(db.prepare('SELECT * FROM floors WHERE id=?').get(req.params.id), '층');
  db.prepare('UPDATE floors SET map_image=NULL WHERE id=?').run(f.id);
  removeFile(f.map_image);
  res.json({ ok: true });
});

// ---------- 분류 (키오스크의 분류 버튼) ----------
router.get('/categories', (req, res) => {
  res.json(
    db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM facilities f WHERE f.category_id=c.id) facility_count
      FROM categories c ORDER BY c.sort_order, c.id`).all()
  );
});

const categoryName = (body) => {
  const name = String(body?.name ?? '').trim();
  need(name, '분류 이름을 입력하세요.');
  return name;
};
const categoryIcon = (body) => {
  const icon = String(body?.icon ?? '').trim();
  need(!icon || ICONS[icon], '없는 아이콘입니다.');
  return icon;
};

router.post('/categories', express.json(), (req, res) => {
  const name = categoryName(req.body);
  need(!db.prepare('SELECT 1 FROM categories WHERE name=?').get(name), '이미 있는 분류입니다.');
  const order = db.prepare('SELECT COALESCE(MAX(sort_order),-1)+1 n FROM categories').get().n;
  res.status(201).json({ id: insert('categories', { name, name_en: String(req.body.name_en ?? '').trim(), icon: categoryIcon(req.body), sort_order: order }) });
});

router.put('/categories/order', express.json(), (req, res) => {
  const stmt = db.prepare('UPDATE categories SET sort_order=? WHERE id=?');
  db.transaction((ids) => ids.forEach((id, i) => stmt.run(i, id)))(req.body.ids || []);
  res.json({ ok: true });
});

router.put('/categories/:id', express.json(), (req, res) => {
  const data = {};
  if (req.body.name !== undefined) {
    data.name = categoryName(req.body);
    need(!db.prepare('SELECT 1 FROM categories WHERE name=? AND id<>?').get(data.name, req.params.id), '이미 있는 분류입니다.');
  }
  if (req.body.name_en !== undefined) data.name_en = String(req.body.name_en ?? '').trim();
  if (req.body.icon !== undefined) data.icon = categoryIcon(req.body);
  found(update('categories', req.params.id, data), '분류');
  res.json({ ok: true });
});

router.delete('/categories/:id', (req, res) => {
  // 이 분류를 쓰던 시설은 '분류 없음'이 된다.
  found(db.prepare('DELETE FROM categories WHERE id=?').run(req.params.id).changes, '분류');
  res.json({ ok: true });
});

// ---------- 시설 ----------
const FACILITY_FIELDS = ['name', 'name_en', 'category_id', 'room_no', 'description', 'description_en', 'phone', 'hours', 'hours_rule', 'keywords', 'pos_x', 'pos_y', 'sort_order', 'floor_id'];
/** 운영시간 규칙은 검사해서 JSON 글자로 저장한다(잘못되면 '표시 안 함'). */
const withRule = (data) => {
  if (data.hours_rule !== undefined) data.hours_rule = data.hours_rule ? JSON.stringify(normalizeRule(data.hours_rule)) : null;
  if (data.hours_rule === 'null') data.hours_rule = null;
  return data;
};

router.post('/floors/:id/facilities', express.json(), (req, res) => {
  found(db.prepare('SELECT id FROM floors WHERE id=?').get(req.params.id), '층');
  const data = withRule(pick(req.body, FACILITY_FIELDS));
  need(data.name, '시설 이름을 입력하세요.');
  // 일괄 입력처럼 운영시간을 글자로만 보낸 경우, 알아들을 수 있으면 규칙으로 바꾼다.
  if (data.hours_rule === undefined && data.hours) {
    const rule = parseHoursText(data.hours);
    if (rule) Object.assign(data, { hours_rule: JSON.stringify(rule), hours: '' });
  }
  const id = insert('facilities', { ...data, floor_id: req.params.id });
  res.status(201).json({ id });
});

router.put('/facilities/:id', express.json(), (req, res) => {
  found(update('facilities', req.params.id, withRule(pick(req.body, FACILITY_FIELDS))), '시설');
  res.json({ ok: true });
});

router.delete('/facilities/:id', (req, res) => {
  found(db.prepare('DELETE FROM facilities WHERE id=?').run(req.params.id).changes, '시설');
  res.json({ ok: true });
});

// ---------- 미디어 라이브러리 ----------
router.get('/media', (req, res) => {
  res.json(
    db.prepare(`SELECT m.*, (SELECT COUNT(*) FROM playlist_items i WHERE i.media_id=m.id) usage
      FROM media m ORDER BY m.id DESC`).all()
  );
});

router.post('/media', upload.array('files', 50), (req, res) => {
  need(req.files?.length, '업로드할 파일을 선택하세요.');
  let meta = [];
  try {
    meta = JSON.parse(req.body.meta || '[]');
  } catch {}
  const ids = db.transaction(() =>
    req.files.map((file, i) => {
      const m = meta[i] || {};
      return insert('media', {
        filename: file.filename,
        original_name: file.originalname,
        title: file.originalname.replace(/\.[^.]+$/, ''),
        type: file.mimetype.startsWith('video/') ? 'video' : 'image',
        mime: file.mimetype,
        size: file.size,
        duration: Number(m.duration) || null,
        width: Number(m.width) || null,
        height: Number(m.height) || null,
      });
    })
  )();
  res.status(201).json({ ids });
});

router.put('/media/:id', express.json(), (req, res) => {
  found(update('media', req.params.id, pick(req.body, ['title'])), '미디어');
  res.json({ ok: true });
});

router.delete('/media/:id', (req, res) => {
  const m = found(db.prepare('SELECT * FROM media WHERE id=?').get(req.params.id), '미디어');
  db.prepare('DELETE FROM media WHERE id=?').run(m.id);
  removeFile(m.filename);
  res.json({ ok: true });
});

// ---------- 재생목록(광고/홍보) ----------
const PLAYLIST_FIELDS = ['name', 'description', 'transition'];
const ITEM_FIELDS = ['duration', 'enabled', 'muted', 'start_date', 'end_date', 'start_time', 'end_time', 'weekdays'];

router.get('/playlists', (req, res) => {
  res.json(
    db.prepare(`SELECT p.*,
      (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id=p.id) item_count,
      (SELECT GROUP_CONCAT(k.name, ', ') FROM kiosks k WHERE k.playlist_id=p.id) kiosk_names
      FROM playlists p ORDER BY p.id`).all()
  );
});

router.post('/playlists', express.json(), (req, res) => {
  const data = pick(req.body, PLAYLIST_FIELDS);
  need(data.name, '재생목록 이름을 입력하세요.');
  const id = insert('playlists', data);
  if (req.body.copy_from) {
    db.prepare(`INSERT INTO playlist_items (playlist_id, media_id, sort_order, duration, enabled, muted, start_date, end_date, start_time, end_time, weekdays)
      SELECT ?, media_id, sort_order, duration, enabled, muted, start_date, end_date, start_time, end_time, weekdays FROM playlist_items WHERE playlist_id=?`).run(id, req.body.copy_from);
  }
  res.status(201).json({ id });
});

router.get('/playlists/:id', (req, res) => {
  const p = found(db.prepare('SELECT * FROM playlists WHERE id=?').get(req.params.id), '재생목록');
  p.items = db.prepare(`SELECT i.*, m.filename, m.title, m.type, m.duration media_duration, m.mime
    FROM playlist_items i JOIN media m ON m.id=i.media_id WHERE i.playlist_id=? ORDER BY i.sort_order, i.id`).all(p.id);
  p.kiosks = db.prepare('SELECT id, name FROM kiosks WHERE playlist_id=?').all(p.id);
  res.json(p);
});

router.put('/playlists/:id', express.json(), (req, res) => {
  found(update('playlists', req.params.id, pick(req.body, PLAYLIST_FIELDS)), '재생목록');
  res.json({ ok: true });
});

router.delete('/playlists/:id', (req, res) => {
  found(db.prepare('DELETE FROM playlists WHERE id=?').run(req.params.id).changes, '재생목록');
  res.json({ ok: true });
});

router.post('/playlists/:id/items', express.json(), (req, res) => {
  found(db.prepare('SELECT id FROM playlists WHERE id=?').get(req.params.id), '재생목록');
  const ids = (req.body.media_ids || []).map(Number).filter(Boolean);
  need(ids.length, '추가할 미디어를 선택하세요.');
  let order = db.prepare('SELECT COALESCE(MAX(sort_order),-1)+1 n FROM playlist_items WHERE playlist_id=?').get(req.params.id).n;
  const stmt = db.prepare('INSERT INTO playlist_items (playlist_id, media_id, sort_order, duration) VALUES (?,?,?,?)');
  db.transaction(() => ids.forEach((mid) => stmt.run(req.params.id, mid, order++, req.body.duration || null)))();
  res.status(201).json({ ok: true });
});

router.put('/playlists/:id/order', express.json(), (req, res) => {
  const stmt = db.prepare('UPDATE playlist_items SET sort_order=? WHERE id=? AND playlist_id=?');
  db.transaction((ids) => ids.forEach((id, i) => stmt.run(i, id, req.params.id)))(req.body.ids || []);
  res.json({ ok: true });
});

router.put('/playlist-items/:id', express.json(), (req, res) => {
  const data = pick(req.body, ITEM_FIELDS);
  if (data.duration != null) need(Number(data.duration) >= 1 && Number(data.duration) <= 3600, '노출 시간은 1~3600초 사이여야 합니다.');
  found(update('playlist_items', req.params.id, data), '재생 항목');
  res.json({ ok: true });
});

router.delete('/playlist-items/:id', (req, res) => {
  found(db.prepare('DELETE FROM playlist_items WHERE id=?').run(req.params.id).changes, '재생 항목');
  res.json({ ok: true });
});

// ---------- 키오스크 ----------
const KIOSK_FIELDS = ['name', 'code', 'building_id', 'playlist_id', 'location', 'floor_id', 'pos_x', 'pos_y', 'mode', 'idle_timeout', 'show_all_buildings', 'enabled', 'memo'];
const CODE_RE = /^[a-zA-Z0-9_-]{2,40}$/;

router.get('/kiosks', (req, res) => {
  res.json(
    db.prepare(`SELECT k.*, b.name building_name, p.name playlist_name, f.name floor_name
      FROM kiosks k LEFT JOIN buildings b ON b.id=k.building_id LEFT JOIN playlists p ON p.id=k.playlist_id
      LEFT JOIN floors f ON f.id=k.floor_id ORDER BY k.name`).all().map(kioskStatus)
  );
});

router.post('/kiosks', express.json(), (req, res) => {
  const data = pick(req.body, KIOSK_FIELDS);
  need(data.name, '키오스크 이름을 입력하세요.');
  data.code = data.code || `kiosk-${crypto.randomBytes(3).toString('hex')}`;
  need(CODE_RE.test(data.code), '코드는 영문/숫자/-/_ 2~40자만 가능합니다.');
  need(!db.prepare('SELECT 1 FROM kiosks WHERE code=?').get(data.code), '이미 사용 중인 코드입니다.');
  const id = insert('kiosks', data);
  res.status(201).json({ id, code: data.code });
});

router.post('/kiosks/:id/duplicate', (req, res) => {
  const k = found(db.prepare('SELECT * FROM kiosks WHERE id=?').get(req.params.id), '키오스크');
  const { id, code, last_seen, last_ip, last_status, created_at, ...rest } = k;
  const newCode = `${code}-copy-${crypto.randomBytes(2).toString('hex')}`.slice(0, 40);
  const newId = insert('kiosks', { ...rest, name: `${k.name} (복사)`, code: newCode });
  res.status(201).json({ id: newId, code: newCode });
});

router.put('/kiosks/:id', express.json(), (req, res) => {
  const data = pick(req.body, KIOSK_FIELDS);
  if (data.code !== undefined) {
    need(CODE_RE.test(data.code || ''), '코드는 영문/숫자/-/_ 2~40자만 가능합니다.');
    need(!db.prepare('SELECT 1 FROM kiosks WHERE code=? AND id<>?').get(data.code, req.params.id), '이미 사용 중인 코드입니다.');
  }
  found(update('kiosks', req.params.id, data), '키오스크');
  res.json({ ok: true });
});

router.delete('/kiosks/:id', (req, res) => {
  const k = found(db.prepare('SELECT * FROM kiosks WHERE id=?').get(req.params.id), '키오스크');
  db.prepare('DELETE FROM kiosks WHERE id=?').run(k.id);
  send(k.code, 'reload');
  res.json({ ok: true });
});

const COMMANDS = ['reload', 'config'];
router.post('/kiosks/:id/command', express.json(), (req, res) => {
  const k = found(db.prepare('SELECT * FROM kiosks WHERE id=?').get(req.params.id), '키오스크');
  const type = req.body.type;
  need(COMMANDS.includes(type), '알 수 없는 명령입니다.');
  sendCommand(k.code, type);
  // SSE 로 바로 전달되거나, SSE 가 막힌 키오스크는 다음 확인(최대 10초) 때 받아 간다.
  res.json({ online: kioskStatus(k).online });
});

// ---------- 공지(하단 티커) ----------
const NOTICE_FIELDS = ['title', 'body', 'target_type', 'target_ids', 'start_at', 'end_at', 'active'];

router.get('/notices', (req, res) => {
  res.json(db.prepare('SELECT * FROM notices ORDER BY sort_order, id DESC').all());
});

router.post('/notices', express.json(), (req, res) => {
  const data = pick(req.body, NOTICE_FIELDS);
  need(data.title, '제목을 입력하세요.');
  if (Array.isArray(data.target_ids)) data.target_ids = data.target_ids.join(',');
  // 새 공지는 맨 앞에 둔다.
  data.sort_order = (db.prepare('SELECT MIN(sort_order) m FROM notices').get().m ?? 1) - 1;
  const id = insert('notices', data);
  res.status(201).json({ id });
});

router.put('/notices/order', express.json(), (req, res) => {
  const stmt = db.prepare('UPDATE notices SET sort_order=? WHERE id=?');
  db.transaction((ids) => ids.forEach((id, i) => stmt.run(i, id)))(req.body.ids || []);
  res.json({ ok: true });
});

router.put('/notices/:id', express.json(), (req, res) => {
  const data = pick(req.body, NOTICE_FIELDS);
  if (Array.isArray(data.target_ids)) data.target_ids = data.target_ids.join(',');
  found(update('notices', req.params.id, data), '공지');
  res.json({ ok: true });
});

router.delete('/notices/:id', (req, res) => {
  found(db.prepare('DELETE FROM notices WHERE id=?').run(req.params.id).changes, '공지');
  res.json({ ok: true });
});

export default router;
