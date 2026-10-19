// 운영시간 규칙: 서버·키오스크·관리자가 함께 쓴다.
// 규칙 모양: { wd: 요일값, sat: 요일값, sun: 요일값 }  (wd = 평일 월~금, sun = 일요일)
// 요일값: { open: 'HH:MM', close: 'HH:MM' } | 'closed'(휴무) | '24h'
// close 가 open 보다 이르거나 같으면 자정을 넘겨 운영하는 것으로 본다(예: 18:00-02:00).

export const DAY_KEYS = ['wd', 'sat', 'sun'];
const DAY_LABEL = { ko: { wd: '평일', sat: '토', sun: '일' }, en: { wd: 'Weekdays', sat: 'Sat', sun: 'Sun' } };
const SOON_MIN = 30; // 종료까지 이 시간(분) 이하로 남으면 '곧 종료'

const pad = (n) => String(n).padStart(2, '0');
const toMin = (hm) => {
  const [hh, mm] = hm.split(':').map(Number);
  return hh * 60 + mm;
};
const validHM = (s) => typeof s === 'string' && /^([01]\d|2[0-4]):[0-5]\d$/.test(s) && toMin(s) <= 1440;

/** 저장 전에 규칙을 검사·정리한다. 잘못된 값이면 null(운영시간 표시 안 함). */
export function normalizeRule(rule) {
  if (typeof rule === 'string') {
    try { rule = JSON.parse(rule); } catch { return null; }
  }
  if (!rule || typeof rule !== 'object') return null;
  const out = {};
  for (const k of DAY_KEYS) {
    const v = rule[k];
    if (v === 'closed' || v === '24h') out[k] = v;
    else if (v && validHM(v.open) && validHM(v.close) && v.open !== v.close) out[k] = { open: v.open, close: v.close };
    else return null;
  }
  return out;
}

// ---------- 예전 글자 운영시간 → 규칙 ----------
const DAY_WORDS = [
  [/^(평일|주중|월\s*[~-]\s*금)/, ['wd']],
  [/^(주말|토\s*[~,·]?\s*일)/, ['sat', 'sun']],
  [/^(토요일|토)/, ['sat']],
  [/^(일요일|일\s*[·,]?\s*공휴일|공휴일|일)/, ['sun']],
  [/^(매일|연중무휴|상시)/, ['wd', 'sat', 'sun']],
];
const TIME_RE = /^(\d{1,2})(?::(\d{2}))?\s*시?\s*[-~–]\s*(\d{1,2})(?::(\d{2}))?\s*시?$/;

/**
 * '평일 09:00-18:00, 토 10:00-15:00, 일 휴무' 같은 글자를 규칙으로 바꾼다.
 * 모든 구절을 알아들었을 때만 규칙을 돌려주고, 하나라도 모르면 null(글자 그대로 둠).
 * 요일을 하나도 말하지 않으면 매일, 일부만 말하면 나머지 요일은 휴무로 본다.
 */
export function parseHoursText(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const rule = {};
  let mentioned = false;
  const setBy = {}; // 각 요일을 정한 구절이 몇 개 요일을 말했는지
  let pending = []; // '토, 일 휴무'처럼 요일만 먼저 나온 경우 다음 구절에 합친다
  for (let part of s.split(/\s*[,/·\n]\s*/).filter(Boolean)) {
    let days = null;
    for (const [re, ds] of DAY_WORDS) {
      const m = part.match(re);
      if (m) { days = ds; part = part.slice(m[0].length).replace(/^[\s:]+/, ''); break; }
    }
    if (days && !part) { pending.push(...days); continue; }
    if (pending.length) { days = [...pending, ...(days || [])]; pending = []; }
    let value;
    if (/^(휴무|휴관|휴일|closed)$/i.test(part)) value = 'closed';
    else if (/^(24\s*시간|24h|00:00\s*[-~]\s*24:00)$/i.test(part)) value = '24h';
    else {
      const m = part.match(TIME_RE);
      if (!m) return null;
      const [oh, om = '00', ch, cm = '00'] = [m[1], m[2], m[3], m[4]];
      if (+oh > 24 || +ch > 24 || +om > 59 || +cm > 59) return null;
      value = { open: `${pad(oh)}:${om}`, close: `${pad(ch)}:${cm}` };
      if (value.open === value.close) return null;
    }
    if (days) mentioned = true;
    // 요일을 말한 구절은 그 요일에, 요일 없는 구절은 아직 정해지지 않은 요일에 적용
    // 요일을 말한 구절은 그 요일에, 요일 없는 구절은 아직 정해지지 않은 요일에 적용한다.
    // '매일 10-22 / 일 휴무'처럼 넓은 범위 뒤에 좁은 범위가 오면 덮어쓰기로 보고,
    // '11:00-14:00, 17:00-19:00'처럼 같은 요일에 시간대가 둘이면 규칙으로 나타낼 수 없으므로 null.
    const span = days ? days.length : 3;
    const targets = days || DAY_KEYS.filter((d) => !(d in rule));
    if (!targets.length) return null;
    if (targets.some((d) => d in rule && setBy[d] <= span)) return null;
    for (const d of targets) { rule[d] = value; setBy[d] = span; }
  }
  if (pending.length) return null;
  for (const d of DAY_KEYS) if (!(d in rule)) rule[d] = mentioned ? 'closed' : null;
  return normalizeRule(rule);
}

// ---------- 표시 ----------
const dayKeyOf = (date) => (date.getDay() === 0 ? 'sun' : date.getDay() === 6 ? 'sat' : 'wd');
const fmt = (v, lang) => (v === 'closed' ? (lang === 'en' ? 'Closed' : '휴무') : v === '24h' ? (lang === 'en' ? 'Open 24h' : '24시간') : `${v.open}–${v.close}`);

/** 한 줄 요약: '평일 09:00–18:00 · 토·일 휴무' (같은 시간인 요일은 묶는다) */
export function summarizeRule(rule, lang = 'ko') {
  if (!rule) return '';
  const L = DAY_LABEL[lang] || DAY_LABEL.ko;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (same(rule.wd, rule.sat) && same(rule.sat, rule.sun)) return `${lang === 'en' ? 'Daily' : '매일'} ${fmt(rule.wd, lang)}`;
  if (same(rule.sat, rule.sun)) return `${L.wd} ${fmt(rule.wd, lang)} · ${lang === 'en' ? 'Weekends' : '주말'} ${fmt(rule.sat, lang)}`;
  return DAY_KEYS.map((d) => `${L[d]} ${fmt(rule[d], lang)}`).join(' · ');
}

/** 오늘 운영시간: '오늘 09:00–18:00' */
export function todayText(rule, now = new Date(), lang = 'ko') {
  if (!rule) return '';
  return `${lang === 'en' ? 'Today' : '오늘'} ${fmt(rule[dayKeyOf(now)], lang)}`;
}

/**
 * 지금 상태. state: open | soon | before | after | closed
 * label 은 화면에 그대로 쓰는 글자.
 */
export function statusAt(rule, now = new Date(), lang = 'ko') {
  if (!rule) return null;
  const en = lang === 'en';
  const cur = now.getHours() * 60 + now.getMinutes();
  const today = rule[dayKeyOf(now)];
  const yest = rule[dayKeyOf(new Date(now.getTime() - 864e5))];
  const open = (closeMin) => (closeMin - cur <= SOON_MIN
    ? { state: 'soon', label: en ? 'Closing soon' : '곧 종료' }
    : { state: 'open', label: en ? 'Open now' : '운영 중' });

  // 어제 자정을 넘겨 운영하는 시간대에 걸쳐 있는지
  if (yest && typeof yest === 'object' && toMin(yest.close) <= toMin(yest.open) && cur < toMin(yest.close)) return open(toMin(yest.close));
  if (today === '24h') return { state: 'open', label: en ? 'Open 24h' : '24시간 운영' };
  if (today === 'closed' || !today) return { state: 'closed', label: en ? 'Closed today' : '오늘 휴무' };
  const o = toMin(today.open);
  let c = toMin(today.close);
  if (c <= o) c += 1440;
  if (cur < o) return { state: 'before', label: en ? `Opens ${today.open}` : `${today.open} 운영 시작` };
  if (cur < c) return open(c);
  return { state: 'after', label: en ? 'Closed' : '운영 종료' };
}
