// 데모 데이터 생성: npm run seed  (이미 데이터가 있으면 건너뜀, --force 로 초기화 후 생성)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { db, UPLOAD_DIR } from './db.js';
import { parseHoursText } from '../public/shared/hours.js';

const force = process.argv.includes('--force');
if (db.prepare('SELECT COUNT(*) c FROM buildings').get().c && !force) {
  console.log('이미 데이터가 있습니다. 초기화하려면: npm run seed -- --force');
  process.exit(0);
}
if (force) {
  db.exec('DELETE FROM notices; DELETE FROM kiosks; DELETE FROM playlist_items; DELETE FROM playlists; DELETE FROM media; DELETE FROM facilities; DELETE FROM floors; DELETE FROM buildings;');
}

const write = (name, content) => {
  fs.writeFileSync(path.join(UPLOAD_DIR, name), content);
  return name;
};

function adSvg(title, sub, c1, c2) {
  // 세로형 키오스크(1080×1920)용 데모 광고
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
  <rect width="1080" height="1920" fill="url(#g)"/>
  <circle cx="900" cy="260" r="420" fill="#fff" opacity=".08"/><circle cx="120" cy="1650" r="340" fill="#fff" opacity=".06"/>
  ${title.split('\n').map((t, i) => `<text x="90" y="${820 + i * 150}" font-family="Pretendard, Apple SD Gothic Neo, sans-serif" font-size="128" font-weight="800" fill="#fff">${t}</text>`).join('')}
  <text x="96" y="${900 + title.split('\n').length * 150}" font-family="Pretendard, Apple SD Gothic Neo, sans-serif" font-size="52" fill="#fff" opacity=".85">${sub}</text>
</svg>`;
}

// 실제 평면도처럼 방 구획만 그린다. 매장·사무실 이름은 관리자가 찍은 핀으로만 표시된다.
function floorSvg(rooms) {
  const cells = rooms
    .map(([x, y, w, hh]) => `<rect x="${x}" y="${y}" width="${w}" height="${hh}" rx="10" fill="#e8eefc" stroke="#94a3b8" stroke-width="3"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
  <rect width="1200" height="800" fill="#f8fafc"/>
  <rect x="40" y="40" width="1120" height="720" rx="18" fill="none" stroke="#475569" stroke-width="6"/>
  <rect x="40" y="360" width="1120" height="90" fill="#f1f5f9"/>
  <text x="600" y="415" text-anchor="middle" font-family="sans-serif" font-size="26" fill="#94a3b8">복도</text>
  ${cells}
</svg>`;
}

const insert = (table, data) => {
  const keys = Object.keys(data);
  return db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((k) => '@' + k).join(',')})`).run(data).lastInsertRowid;
};

db.transaction(() => {
  // 미디어
  const ads = [
    ['신입생\n오리엔테이션', '3월 2일 대강당 · 오전 10시', '#1d4ed8', '#7c3aed'],
    ['도서관\n24시간 개방', '시험기간 열람실 연장 운영', '#0f766e', '#22c55e'],
    ['카페 세종\n신메뉴', '아메리카노 1+1 이벤트 진행 중', '#9a3412', '#f59e0b'],
    ['취업박람회\n2026', '세종관 1층 · 60개 기업 참여', '#be123c', '#f472b6'],
  ].map(([t, s, a, b], i) => {
    const filename = write(`demo-ad-portrait-${i + 1}.svg`, adSvg(t, s, a, b));
    return insert('media', { filename, original_name: filename, title: t.replace('\n', ' '), type: 'image', mime: 'image/svg+xml', size: 2000, width: 1080, height: 1920 });
  });

  let videoId = null;
  try {
    const name = 'demo-video-portrait.mp4';
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30:duration=6', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', path.join(UPLOAD_DIR, name)]);
    const size = fs.statSync(path.join(UPLOAD_DIR, name)).size;
    videoId = insert('media', { filename: name, original_name: name, title: '홍보 영상(데모 6초)', type: 'video', mime: 'video/mp4', size, duration: 6, width: 720, height: 1280 });
  } catch {
    console.log('ffmpeg 가 없어 데모 동영상은 건너뜁니다.');
  }

  const pl = insert('playlists', { name: '본관 로비 홍보', description: '정문 로비용 기본 재생목록', transition: 'slide' });
  const order = [ads[0], videoId, ads[1], ads[2]].filter(Boolean);
  order.forEach((mid, i) => insert('playlist_items', { playlist_id: pl, media_id: mid, sort_order: i, duration: i === 0 ? 10 : null }));
  const pl2 = insert('playlists', { name: '세종관 홍보', transition: 'fade' });
  [ads[3], ads[1]].forEach((mid, i) => insert('playlist_items', { playlist_id: pl2, media_id: mid, sort_order: i }));

  // 건물 · 층 · 시설
  const main = insert('buildings', { name: '본관', code: 'A', address: '정문 쪽', sort_order: 0 });
  const sejong = insert('buildings', { name: '세종관', code: 'B', address: '본관 뒤편', sort_order: 1 });

  const categoryId = (name) => {
    const found = db.prepare('SELECT id FROM categories WHERE name=?').get(name);
    if (found) return found.id;
    const order = db.prepare('SELECT COALESCE(MAX(sort_order),-1)+1 n FROM categories').get().n;
    return insert('categories', { name, sort_order: order });
  };
  const addFloor = (bid, name, level, description, rooms, facilities) => {
    const map = rooms ? write(`demo-floor-${bid}-${level}.svg`, floorSvg(rooms)) : null;
    const fid = insert('floors', { building_id: bid, name, level, description, map_image: map });
    facilities.forEach(([fname, category, room_no, hours, keywords, x, y], i) => {
      // 알아들을 수 있는 운영시간은 요일별 규칙으로, 아니면 메모로 넣는다.
      const rule = parseHoursText(hours);
      insert('facilities', { floor_id: fid, name: fname, category_id: categoryId(category), room_no, hours: rule ? '' : hours, hours_rule: rule ? JSON.stringify(rule) : null, keywords, pos_x: x ?? null, pos_y: y ?? null, sort_order: i });
    });
    return fid;
  };

  addFloor(main, 'B1', -1, '주차장 · 기계실', null, [
    ['지하주차장', '주차장', '', '24시간', '주차,차량', null, null],
    ['방재실', '기타', 'B01', '24시간', '소방,보안', null, null],
  ]);
  const mainF1 = addFloor(main, '1F', 1, '로비 · 안내데스크 · 카페',
    [[60, 60, 300, 280, '안내데스크'], [400, 60, 360, 280, '카페 세종'], [800, 60, 340, 280, '편의점'], [60, 470, 420, 270, '학생지원팀'], [520, 470, 300, 270, '화장실'], [860, 470, 280, 270, '엘리베이터']],
    [
      ['종합안내데스크', '민원/안내', '100', '평일 09:00-18:00', '안내,분실물,문의', 17.5, 25],
      ['카페 세종', '카페', '102', '08:00-20:00', '커피,음료', 48, 25],
      ['세븐일레븐', '편의점', '103', '07:00-23:00', '편의점,간식', 79, 25],
      ['학생지원팀', '사무실', '110', '평일 09:00-18:00', '장학금,증명서,휴학,복학', 22.5, 76],
      ['화장실(남/여)', '화장실', '', '', '화장실', 55.8, 76],
      ['엘리베이터', '엘리베이터', '', '', 'EV,승강기', 83.3, 76],
    ]);
  addFloor(main, '2F', 2, '행정 사무실',
    [[60, 60, 520, 280, '총무팀'], [620, 60, 520, 280, '교무팀'], [60, 470, 520, 270, '회의실 A'], [620, 470, 520, 270, '화장실']],
    [
      ['총무팀', '사무실', '201', '평일 09:00-18:00', '구매,시설', 26.7, 25],
      ['교무팀', '사무실', '202', '평일 09:00-18:00', '수강신청,성적,학사', 73.3, 25],
      ['회의실 A', '회의실', '210', '예약제', '회의', 26.7, 76],
      ['화장실(남/여)', '화장실', '', '', '화장실', 73.3, 76],
    ]);
  addFloor(main, '3F', 3, '강의실', null, [
    ['301 강의실', '강의실', '301', '', '수업', null, null],
    ['302 강의실', '강의실', '302', '', '수업', null, null],
    ['교수 연구실', '사무실', '310-320', '', '교수,면담', null, null],
  ]);
  addFloor(sejong, '1F', 1, '대강당 · 식당', null, [
    ['대강당', '강의실', '101', '', '행사,오리엔테이션,강당', null, null],
    ['학생식당', '식당', '110', '11:00-14:00, 17:00-19:00', '밥,점심,저녁,학식', null, null],
    ['ATM', '은행/ATM', '', '24시간', '현금,은행', null, null],
  ]);
  addFloor(sejong, '2F', 2, '도서관', null, [
    ['중앙도서관', '기타', '200', '09:00-22:00', '책,열람실,대출', null, null],
    ['보건실', '의료', '210', '평일 09:00-17:00', '병원,약,응급', null, null],
  ]);

  const k1 = insert('kiosks', { name: '본관 1층 정문 로비', code: 'main-lobby', building_id: main, playlist_id: pl, location: '정문 엘리베이터 앞', floor_id: mainF1, pos_x: 50, pos_y: 51, idle_timeout: 30 });
  insert('kiosks', { name: '세종관 1층 입구', code: 'sejong-1f', building_id: sejong, playlist_id: pl2, location: '세종관 주출입구', idle_timeout: 30 });
  insert('kiosks', { name: '본관 2층 복도(홍보전용)', code: 'main-2f-signage', building_id: main, playlist_id: pl, location: '2층 복도', mode: 'signage' });

  // 키오스크 English 화면용 영문 이름(데모)
  const EN = {
    buildings: { 본관: 'Main Hall', 세종관: 'Sejong Hall' },
    floors: { '주차장 · 기계실': 'Parking · Machine room', '로비 · 안내데스크 · 카페': 'Lobby · Info desk · Cafe', '행정 사무실': 'Admin offices', 강의실: 'Classrooms', '대강당 · 식당': 'Auditorium · Cafeteria', 도서관: 'Library' },
    facilities: { 지하주차장: 'Underground parking', 방재실: 'Disaster control room', 종합안내데스크: 'Information desk', '카페 세종': 'Cafe Sejong', 세븐일레븐: '7-Eleven', 학생지원팀: 'Student Support', '화장실(남/여)': 'Restrooms', 엘리베이터: 'Elevator', 총무팀: 'General Affairs', 교무팀: 'Academic Affairs', '회의실 A': 'Meeting room A', '301 강의실': 'Classroom 301', '302 강의실': 'Classroom 302', '교수 연구실': "Professors' offices", 대강당: 'Auditorium', 학생식당: 'Student cafeteria', ATM: 'ATM', 중앙도서관: 'Central Library', 보건실: 'Health center' },
  };
  for (const [ko, en] of Object.entries(EN.buildings)) db.prepare('UPDATE buildings SET name_en=? WHERE name=?').run(en, ko);
  for (const [ko, en] of Object.entries(EN.floors)) db.prepare('UPDATE floors SET description_en=? WHERE description=?').run(en, ko);
  for (const [ko, en] of Object.entries(EN.facilities)) db.prepare('UPDATE facilities SET name_en=? WHERE name=?').run(en, ko);

  insert('notices', { title: '시험기간 도서관 24시간 개방', body: '6/10~6/21 세종관 2층 열람실', level: 'ticker', target_type: 'all' });
  insert('notices', { title: '본관 2층 화장실 공사', body: '1층 화장실을 이용해 주세요', level: 'ticker', target_type: 'kiosk', target_ids: String(k1) });
})();

console.log('데모 데이터를 만들었습니다. 키오스크 코드: main-lobby, sejong-1f, main-2f-signage');
