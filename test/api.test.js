import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-test-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.ADMIN_PASSWORD = 'test-pass';

let server, base, cookie;

async function call(method, url, body, { auth = true, raw = false } = {}) {
  const headers = {};
  if (auth && cookie) headers.cookie = cookie;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const r = await fetch(base + url, { method, headers, body: payload });
  if (raw) return r;
  return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() };
}

before(async () => {
  const { createApp } = await import('../server/index.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('관리자 API 는 로그인 없이 막힌다', async () => {
  assert.equal((await call('GET', '/api/kiosks', undefined, { auth: false })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { password: 'wrong' })).status, 401);
  const r = await call('POST', '/api/auth/login', { password: 'test-pass' }, { raw: true });
  assert.equal(r.status, 200);
  cookie = r.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('GET', '/api/auth/me')).status, 200);
});

let buildingId, floorId, playlistId, kioskId, mediaIds;

test('건물 → 층 → 시설 등록', async () => {
  buildingId = (await call('POST', '/api/buildings', { name: 'A동' })).body.id;
  assert.equal((await call('POST', '/api/buildings', { name: '' })).status, 400);
  floorId = (await call('POST', `/api/buildings/${buildingId}/floors`, { name: '1F', level: 1 })).body.id;
  await call('POST', `/api/buildings/${buildingId}/floors`, { name: 'B1', level: -1 });
  const office = (await call('GET', '/api/categories')).body.find((c) => c.name === '사무실');
  assert.ok(office, '기본 분류가 만들어져 있어야 한다');
  await call('POST', `/api/floors/${floorId}/facilities`, { name: '학생지원팀', category_id: office.id, keywords: '장학금', pos_x: 10, pos_y: 20 });
  const tree = (await call('GET', `/api/buildings/${buildingId}/tree`)).body;
  assert.deepEqual(tree.floors.map((f) => f.name), ['1F', 'B1']); // 높은 층부터
  assert.equal(tree.floors[0].facilities[0].name, '학생지원팀');
  assert.equal(tree.floors[0].facilities[0].category, '사무실');
});

test('시설 운영시간 규칙·영문 이름: 저장·검사·글자 자동 변환', async () => {
  const rule = { wd: { open: '09:00', close: '18:00' }, sat: 'closed', sun: '24h' };
  const id = (await call('POST', `/api/floors/${floorId}/facilities`, { name: '카페', name_en: 'Cafe', hours_rule: rule })).body.id;
  let fac = (await call('GET', `/api/buildings/${buildingId}/tree`)).body.floors[0].facilities.find((x) => x.id === id);
  assert.deepEqual(JSON.parse(fac.hours_rule), rule);
  assert.equal(fac.name_en, 'Cafe');
  // 잘못된 규칙은 '표시 안 함'
  await call('PUT', `/api/facilities/${id}`, { hours_rule: { wd: { open: 'x', close: '18:00' } } });
  fac = (await call('GET', `/api/buildings/${buildingId}/tree`)).body.floors[0].facilities.find((x) => x.id === id);
  assert.equal(fac.hours_rule, null);
  // 일괄 입력처럼 글자로만 보내면 알아들을 수 있는 경우 규칙으로 바꾼다
  const id2 = (await call('POST', `/api/floors/${floorId}/facilities`, { name: '편의점', hours: '평일 07:00-23:00 / 주말 휴무' })).body.id;
  const id3 = (await call('POST', `/api/floors/${floorId}/facilities`, { name: '회의실', hours: '예약제' })).body.id;
  const facs = (await call('GET', `/api/buildings/${buildingId}/tree`)).body.floors[0].facilities;
  assert.equal(JSON.parse(facs.find((x) => x.id === id2).hours_rule).sat, 'closed');
  assert.equal(facs.find((x) => x.id === id2).hours, '');
  assert.equal(facs.find((x) => x.id === id3).hours, '예약제');
  for (const x of [id, id2, id3]) await call('DELETE', `/api/facilities/${x}`);
});

test('분류: 관리자가 추가·이름 변경·순서 변경·삭제하고 키오스크에 그대로 반영된다', async () => {
  const id = (await call('POST', '/api/categories', { name: '열람실' })).body.id;
  assert.equal((await call('POST', '/api/categories', { name: '열람실' })).status, 400); // 중복
  assert.equal((await call('POST', '/api/categories', { name: '  ' })).status, 400);
  await call('PUT', `/api/categories/${id}`, { name: '독서실' });
  await call('PUT', `/api/categories/${id}`, { name_en: 'Study room' }); // 영문 이름만 바꿔도 한국어 이름은 그대로
  assert.equal((await call('GET', '/api/categories')).body.find((c) => c.id === id).name, '독서실');
  // 아이콘: 목록에 있는 이름만
  assert.equal((await call('PUT', `/api/categories/${id}`, { icon: 'no-such-icon' })).status, 400);
  await call('PUT', `/api/categories/${id}`, { icon: 'book-open' });
  assert.equal((await call('GET', '/api/categories')).body.find((c) => c.id === id).icon, 'book-open');
  assert.equal((await call('GET', '/api/categories')).body.find((c) => c.name === '카페').icon, 'coffee'); // 기본 분류 아이콘
  let cats = (await call('GET', '/api/categories')).body;
  // 맨 앞으로 이동
  await call('PUT', '/api/categories/order', { ids: [id, ...cats.filter((c) => c.id !== id).map((c) => c.id)] });
  cats = (await call('GET', '/api/categories')).body;
  assert.equal(cats[0].name, '독서실');
  const fac = (await call('POST', `/api/floors/${floorId}/facilities`, { name: '1열람실', category_id: id })).body.id;
  await call('DELETE', `/api/categories/${id}`);
  const tree = (await call('GET', `/api/buildings/${buildingId}/tree`)).body;
  const f = tree.floors.flatMap((x) => x.facilities).find((x) => x.id === fac);
  assert.equal(f.category_id, null); // 분류를 지우면 시설은 '분류 없음'
  await call('DELETE', `/api/facilities/${fac}`);
});

test('미디어 업로드: 허용 형식만, 한글 파일명 보존', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6300010000000500010d0a2db40000000049454e44ae426082', 'hex');
  const fd = new FormData();
  fd.append('files', new Blob([png], { type: 'image/png' }), '홍보1.png');
  fd.append('files', new Blob([png], { type: 'image/png' }), '홍보2.png');
  fd.append('meta', JSON.stringify([{ width: 1, height: 1 }, {}]));
  const r = await call('POST', '/api/media', fd);
  assert.equal(r.status, 201);
  mediaIds = r.body.ids;
  const list = (await call('GET', '/api/media')).body;
  assert.equal(list.find((m) => m.id === mediaIds[0]).title, '홍보1');

  const bad = new FormData();
  bad.append('files', new Blob(['<svg/>'], { type: 'image/svg+xml' }), 'x.svg');
  assert.equal((await call('POST', '/api/media', bad)).status, 400);
});

test('재생목록: 추가 · 순서 변경 · 노출시간', async () => {
  playlistId = (await call('POST', '/api/playlists', { name: '로비' })).body.id;
  await call('POST', `/api/playlists/${playlistId}/items`, { media_ids: mediaIds });
  let p = (await call('GET', `/api/playlists/${playlistId}`)).body;
  assert.deepEqual(p.items.map((i) => i.media_id), mediaIds);
  await call('PUT', `/api/playlists/${playlistId}/order`, { ids: p.items.map((i) => i.id).reverse() });
  assert.equal((await call('PUT', `/api/playlist-items/${p.items[0].id}`, { duration: 0 })).status, 400);
  await call('PUT', `/api/playlist-items/${p.items[0].id}`, { duration: 12 });
  p = (await call('GET', `/api/playlists/${playlistId}`)).body;
  assert.deepEqual(p.items.map((i) => i.media_id), [...mediaIds].reverse());
  assert.equal(p.items.find((i) => i.media_id === mediaIds[0]).duration, 12);
});

test('키오스크 등록과 설정 조회', async () => {
  const r = await call('POST', '/api/kiosks', { name: '로비', code: 'lobby-1', building_id: buildingId, playlist_id: playlistId, floor_id: floorId, show_all_buildings: 0 });
  kioskId = r.body.id;
  assert.equal((await call('POST', '/api/kiosks', { name: '중복', code: 'lobby-1' })).status, 400);
  assert.equal((await call('POST', '/api/kiosks', { name: '잘못', code: '한글코드' })).status, 400);

  const other = (await call('POST', '/api/buildings', { name: 'B동' })).body.id;
  const cfg = (await call('GET', '/api/k/lobby-1/config', undefined, { auth: false })).body;
  assert.equal(cfg.kiosk.image_duration, 5);
  assert.equal(cfg.playlist.length, 2);
  assert.deepEqual(cfg.buildings.map((b) => b.id), [buildingId]); // 다른 동 숨김
  assert.ok(cfg.categories.length > 0 && cfg.categories[0].name, '키오스크 설정에 분류 순서가 들어 있어야 한다');
  assert.equal(cfg.buildings[0].floors[0].facilities[0].category, '사무실');
  // English 화면용 영문 이름과, 단말이 바로 쓰는 운영시간 규칙(객체)
  assert.equal(cfg.buildings[0].floors[0].facilities[0].category_en, 'Office');
  assert.ok('name_en' in cfg.buildings[0] && 'description_en' in cfg.buildings[0].floors[0]);
  assert.ok(cfg.categories.find((c) => c.name === '사무실').name_en);
  assert.ok(!cfg.buildings.some((b) => b.id === other));
  assert.equal((await call('GET', '/api/k/nope/config', undefined, { auth: false })).status, 404);
});

test('기간이 끝난 항목과 숨긴 항목은 키오스크에 내려가지 않는다', async () => {
  const p = (await call('GET', `/api/playlists/${playlistId}`)).body;
  await call('PUT', `/api/playlist-items/${p.items[0].id}`, { end_date: '2000-01-01' });
  await call('PUT', `/api/playlist-items/${p.items[1].id}`, { enabled: 0 });
  const cfg = (await call('GET', '/api/k/lobby-1/config', undefined, { auth: false })).body;
  assert.equal(cfg.playlist.length, 0);
});

test('공지 대상 지정: 동/키오스크 단위, 기간 만료·꺼짐 제외', async () => {
  await call('POST', '/api/notices', { title: '전체공지', target_type: 'all' });
  await call('POST', '/api/notices', { title: 'A동 공지', target_type: 'building', target_ids: [buildingId] });
  await call('POST', '/api/notices', { title: '다른 키오스크', target_type: 'kiosk', target_ids: [9999] });
  await call('POST', '/api/notices', { title: '만료', end_at: '2000-01-01T00:00' });
  const off = (await call('POST', '/api/notices', { title: '꺼짐' })).body.id;
  await call('PUT', `/api/notices/${off}`, { active: 0 });
  const titles = (await call('GET', '/api/k/lobby-1/config', undefined, { auth: false })).body.notices.map((n) => n.title).sort();
  assert.deepEqual(titles, ['A동 공지', '전체공지']);
});

test('공지 순서: 새 공지는 맨 앞, 순서 변경이 키오스크에 반영된다', async () => {
  const kioskTitles = async () => (await call('GET', '/api/k/lobby-1/config', undefined, { auth: false })).body.notices.map((n) => n.title);
  assert.deepEqual(await kioskTitles(), ['A동 공지', '전체공지']);
  const ids = (await call('GET', '/api/notices')).body.map((n) => n.id);
  await call('PUT', '/api/notices/order', { ids: [...ids].reverse() });
  assert.deepEqual(await kioskTitles(), ['전체공지', 'A동 공지']);
});

test('하트비트로 온라인 상태와 현재 재생 콘텐츠가 보인다', async () => {
  await call('POST', '/api/k/lobby-1/heartbeat', { mode: 'signage', current: '홍보1' }, { auth: false });
  const k = (await call('GET', '/api/kiosks')).body.find((x) => x.id === kioskId);
  assert.equal(k.online, true);
  assert.equal(k.last_status.current, '홍보1');
});

test('삭제된 기능(대시보드·통계·이용 로그) API 는 없다', async () => {
  assert.equal((await call('GET', '/api/dashboard')).status, 404);
  assert.equal((await call('GET', '/api/stats')).status, 404);
  assert.equal((await call('POST', '/api/k/lobby-1/log', { events: [] }, { auth: false })).status, 404);
});

test('미디어 삭제 시 재생목록에서도 빠진다', async () => {
  await call('DELETE', `/api/media/${mediaIds[0]}`);
  const p = (await call('GET', `/api/playlists/${playlistId}`)).body;
  assert.deepEqual(p.items.map((i) => i.media_id), [mediaIds[1]]);
});

test('원격 명령은 SSE 가 막혀도 주기 확인(poll)으로 한 번만 전달된다', async () => {
  const before = (await call('GET', '/api/k/lobby-1/config', undefined, { auth: false })).body.command_clock;
  assert.ok(before > 0);
  const r = await call('POST', `/api/kiosks/${kioskId}/command`, { type: 'config' });
  assert.equal(r.body.online, true); // 앞선 하트비트로 온라인
  const p1 = (await call('GET', `/api/k/lobby-1/poll?since=${before}`, undefined, { auth: false })).body;
  assert.equal(p1.commands.length, 1);
  assert.equal(p1.commands[0].type, 'config');
  assert.ok(p1.version);
  const p2 = (await call('GET', `/api/k/lobby-1/poll?since=${p1.commands[0].id}`, undefined, { auth: false })).body;
  assert.equal(p2.commands.length, 0);
  assert.equal((await call('POST', `/api/kiosks/${kioskId}/command`, { type: 'rm -rf' })).status, 400);
  assert.equal((await call('POST', `/api/kiosks/${kioskId}/command`, { type: 'identify' })).status, 400);
});

test('비밀번호를 10번 틀리면 15분간 로그인이 막힌다', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await call('POST', '/api/auth/login', { password: `wrong-${i}` })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { password: 'test-pass' })).status, 429);
});
