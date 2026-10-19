import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { parseHoursText } from '../public/shared/hours.js';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
export const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(ROOT, 'uploads');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new Database(process.env.DB_FILE || path.join(DATA_DIR, 'kiosk.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS buildings (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT,
  description TEXT DEFAULT '',
  address TEXT DEFAULT '',
  color TEXT DEFAULT '#2563eb',   -- 사용 안 함(색상은 키오스크 공통 강조색 하나로 통일)
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS floors (
  id INTEGER PRIMARY KEY,
  building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  level INTEGER DEFAULT 0,
  description TEXT DEFAULT '',
  map_image TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS facilities (
  id INTEGER PRIMARY KEY,
  floor_id INTEGER NOT NULL REFERENCES floors(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  room_no TEXT DEFAULT '',
  description TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  hours TEXT DEFAULT '',
  keywords TEXT DEFAULT '',
  pos_x REAL,
  pos_y REAL,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY,
  filename TEXT NOT NULL,
  original_name TEXT,
  title TEXT,
  type TEXT NOT NULL CHECK (type IN ('image','video')),
  mime TEXT,
  size INTEGER DEFAULT 0,
  duration REAL,
  width INTEGER,
  height INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  transition TEXT DEFAULT 'slide',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS playlist_items (
  id INTEGER PRIMARY KEY,
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  sort_order INTEGER DEFAULT 0,
  duration INTEGER,              -- 사진 노출 초 (NULL 이면 키오스크 기본값)
  enabled INTEGER DEFAULT 1,
  muted INTEGER DEFAULT 1,
  start_date TEXT,               -- YYYY-MM-DD
  end_date TEXT,
  start_time TEXT,               -- HH:MM
  end_time TEXT,
  weekdays TEXT                  -- "0,1,2,3,4,5,6" (0=일) NULL=매일
);

CREATE TABLE IF NOT EXISTS kiosks (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  building_id INTEGER REFERENCES buildings(id) ON DELETE SET NULL,
  playlist_id INTEGER REFERENCES playlists(id) ON DELETE SET NULL,
  location TEXT DEFAULT '',
  floor_id INTEGER REFERENCES floors(id) ON DELETE SET NULL,
  pos_x REAL,
  pos_y REAL,
  mode TEXT DEFAULT 'interactive' CHECK (mode IN ('interactive','signage')),
  image_duration INTEGER DEFAULT 5,   -- 사용 안 함(사진 기본 노출은 5초 고정)
  idle_timeout INTEGER DEFAULT 30,
  show_all_buildings INTEGER DEFAULT 1,
  enabled INTEGER DEFAULT 1,
  memo TEXT DEFAULT '',
  last_seen TEXT,
  last_ip TEXT,
  last_status TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT DEFAULT '',
  level TEXT DEFAULT 'ticker',    -- 예전 버전 호환용(현재는 하단 티커만 사용)
  target_type TEXT DEFAULT 'all' CHECK (target_type IN ('all','building','kiosk')),
  target_ids TEXT DEFAULT '',     -- 콤마로 구분된 id 목록
  start_at TEXT,
  end_at TEXT,
  active INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,   -- 키오스크 하단에 흐르는 순서
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

// 공지 순서: 예전 DB에는 칸이 없으므로 추가하고, 기존 순서(최신 공지 먼저)를 그대로 옮긴다.
if (!db.prepare('PRAGMA table_info(notices)').all().some((c) => c.name === 'sort_order')) {
  db.exec('ALTER TABLE notices ADD COLUMN sort_order INTEGER DEFAULT 0');
  const setOrder = db.prepare('UPDATE notices SET sort_order=? WHERE id=?');
  db.prepare('SELECT id FROM notices ORDER BY id DESC').all().forEach((n, i) => setOrder.run(i, n.id));
}

// 이전 버전에서 쓰던 긴급 송출·통계·변경이력 데이터 정리
db.exec(`
DELETE FROM notices WHERE level = 'emergency';
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS audit_log;
`);

// 분류: 예전에는 시설마다 글자로 입력했으나 이제 관리자가 관리하는 목록에서 고른다.
const DEFAULT_CATEGORIES = ['민원/안내', '사무실', '강의실', '회의실', '식당', '카페', '편의점', '의료', '은행/ATM', '화장실', '엘리베이터', '주차장', '휴게실', '기타'];
const facilityCols = db.prepare('PRAGMA table_info(facilities)').all().map((c) => c.name);
db.transaction(() => {
  const addCategory = db.prepare('INSERT OR IGNORE INTO categories (name, sort_order) VALUES (?, ?)');
  if (facilityCols.includes('category')) {
    if (!facilityCols.includes('category_id')) db.exec('ALTER TABLE facilities ADD COLUMN category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL');
    const used = db.prepare("SELECT DISTINCT TRIM(category) name FROM facilities WHERE TRIM(COALESCE(category, '')) <> ''").all().map((r) => r.name);
    const ordered = [...DEFAULT_CATEGORIES, ...used.filter((n) => !DEFAULT_CATEGORIES.includes(n)).sort()];
    ordered.forEach((name, i) => addCategory.run(name, i));
    db.exec('UPDATE facilities SET category_id = (SELECT id FROM categories WHERE name = TRIM(facilities.category))');
    db.exec('ALTER TABLE facilities DROP COLUMN category');
  }
  if (!db.prepare('SELECT COUNT(*) c FROM categories').get().c) DEFAULT_CATEGORIES.forEach((name, i) => addCategory.run(name, i));
})();

// ---------- 운영시간 규칙 · 영문 표기 칸 (기존 DB에 없으면 추가) ----------
const hasCol = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
const addCol = (table, col, def) => { if (hasCol(table, col)) return false; db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); return true; };
addCol('buildings', 'name_en', "TEXT DEFAULT ''");
addCol('floors', 'description_en', "TEXT DEFAULT ''");
addCol('categories', 'name_en', "TEXT DEFAULT ''");
addCol('facilities', 'name_en', "TEXT DEFAULT ''");
addCol('facilities', 'description_en', "TEXT DEFAULT ''");
if (addCol('facilities', 'hours_rule', 'TEXT')) {
  // 예전에 글자로 적은 운영시간을 규칙으로 옮긴다. 알아들을 수 없는 글자는 메모로 그대로 둔다.
  const setRule = db.prepare("UPDATE facilities SET hours_rule=?, hours='' WHERE id=?");
  db.transaction(() => {
    for (const f of db.prepare("SELECT id, hours FROM facilities WHERE TRIM(COALESCE(hours,'')) <> ''").all()) {
      const rule = parseHoursText(f.hours);
      if (rule) setRule.run(JSON.stringify(rule), f.id);
    }
  })();
}
// 영문 기본 분류명
const CATEGORY_EN = { '민원/안내': 'Information', 사무실: 'Office', 강의실: 'Classroom', 회의실: 'Meeting room', 식당: 'Restaurant', 카페: 'Cafe', 편의점: 'Convenience store', 의료: 'Medical', '은행/ATM': 'Bank/ATM', 화장실: 'Restroom', 엘리베이터: 'Elevator', 주차장: 'Parking', 휴게실: 'Lounge', 기타: 'Other' };
{
  const setEn = db.prepare("UPDATE categories SET name_en=? WHERE name=? AND COALESCE(name_en,'')=''");
  for (const [ko, en] of Object.entries(CATEGORY_EN)) setEn.run(en, ko);
}
// 분류 아이콘 (public/shared/icons.js 의 이름). 기본 분류는 처음 한 번 채워 둔다.
const CATEGORY_ICON = { '민원/안내': 'info', 사무실: 'briefcase-business', 강의실: 'graduation-cap', 회의실: 'users', 식당: 'utensils', 카페: 'coffee', 편의점: 'store', 의료: 'stethoscope', '은행/ATM': 'landmark', 화장실: 'toilet', 엘리베이터: 'arrow-up-down', 주차장: 'square-parking', 휴게실: 'sofa', 기타: 'ellipsis' };
if (addCol('categories', 'icon', "TEXT DEFAULT ''")) {
  const setIcon = db.prepare('UPDATE categories SET icon=? WHERE name=?');
  for (const [ko, icon] of Object.entries(CATEGORY_ICON)) setIcon.run(icon, ko);
}
