// 키오스크 플레이어: 홍보 사이니지 + 터치 층별안내 + 하단 공지
import { statusAt, summarizeRule, todayText } from '/shared/hours.js';
import { iconSvg } from '/shared/icons.js';

const code = decodeURIComponent(location.pathname.split('/')[2] || '');
const PREVIEW = new URLSearchParams(location.search).has('preview'); // 관리자 미리보기: 상태 보고를 하지 않는다
const CACHE_KEY = `kiosk-config:${code}`;
const CMD_KEY = `kiosk-last-command:${code}`;
const POLL_MS = 10000;
const BOOT = Date.now();

const $ = (s) => document.querySelector(s);
/** null/false 를 걸러내고 자식 요소를 교체한다(replaceChildren 은 null 을 'null' 글자로 넣는다). */
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
};

const state = {
  config: null,
  mode: 'signage', // signage | directory
  buildingId: null,
  floorId: null,
  // 층별 안내 보기 방식: floor = 층 버튼으로 고른 한 층(도면, 없으면 그 층 시설 목록)
  //                     list  = [전체]/분류 버튼으로 고른 동 전체 시설 목록(층별로 묶음)
  view: 'floor',
  query: '',
  category: null, // list 일 때 분류 id (null 이면 전체)
  lastTouch: Date.now(),
  errors: 0,
  blocked: false, // 미등록/사용 안 함 → 점검 중
  lang: 'ko', // 층별 안내 화면 언어(ko | en). 홍보 화면으로 돌아가면 한국어로 되돌린다.
};

// ---------- 언어 ----------
const TEXT = {
  ko: {
    large: '큰 글씨', home: '홍보 화면', lang: 'English', search: '시설명·호실·키워드 검색 (초성 가능)',
    all: '전체', hereTag: '현위치', youAreHere: '현재 위치', floorCount: (n) => `${n}개 시설`,
    noFloors: '등록된 층이 없습니다', noFloorInfo: '층 정보 없음', noData: '관리자에서 층과 시설을 등록하세요.',
    floorEmpty: '이 층에 등록된 시설이 없습니다.', results: (n) => `검색 결과 ${n}건`, allPlaces: '전체 시설',
    placeCount: (name, n) => `${name} ${n}곳`, allBuildings: '모든 동', noResults: '검색 결과가 없습니다. 다른 이름이나 초성으로 검색해 보세요.',
    noPlaces: '등록된 시설이 없습니다.', room: (r) => `${r}호`, location: '위치', category: '분류', hours: '운영시간', phone: '연락처',
    space: '띄어쓰기', clear: '전체 지우기', close: '닫기', mapAlt: (f) => `${f} 도면`,
  },
  en: {
    large: 'Large text', home: 'Home', lang: '한국어', search: 'Search places, rooms, keywords',
    all: 'All', hereTag: 'Here', youAreHere: 'You are here', floorCount: (n) => `${n} places`,
    noFloors: 'No floors', noFloorInfo: 'No floor info', noData: 'No floor information yet.',
    floorEmpty: 'No places on this floor.', results: (n) => `${n} result${n === 1 ? '' : 's'}`, allPlaces: 'All places',
    placeCount: (name, n) => `${name} (${n})`, allBuildings: 'All buildings', noResults: 'No results. Try another name.',
    noPlaces: 'No places.', room: (r) => `Room ${r}`, location: 'Location', category: 'Category', hours: 'Hours', phone: 'Phone',
    space: 'Space', clear: 'Clear', close: 'Close', mapAlt: (f) => `${f} floor plan`,
  },
};
const T = () => TEXT[state.lang];
const en = () => state.lang === 'en';
// 영문 이름이 없으면 한국어 이름을 그대로 쓴다.
const nm = (x) => (en() && x?.name_en) || x?.name || '';
const floorDesc = (f) => (en() && f.description_en) || f.description;
const catLabel = (fac) => (en() && fac.category_en) || fac.category;
/** 분류 아이콘 (없으면 null) */
const iconEl = (name) => {
  const svg = iconSvg(name);
  if (!svg) return null;
  const el = h('span', { class: 'ico' });
  el.innerHTML = svg;
  return el;
};
const catTag = (fac) => (catLabel(fac) ? h('span', { class: 'cat' }, iconEl(fac.category_icon), catLabel(fac)) : null);


// ---------- 유틸 ----------
const pad = (n) => String(n).padStart(2, '0');
const todayStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const nowHM = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const mediaUrl = (f) => `/uploads/${encodeURIComponent(f)}`;

const CHO = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
const chosung = (s) =>
  [...s].map((ch) => {
    const c = ch.charCodeAt(0) - 0xac00;
    return c >= 0 && c <= 11171 ? CHO[Math.floor(c / 588)] : ch;
  }).join('');
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
const isChosungOnly = (s) => /^[ㄱ-ㅎ]+$/.test(s);

// ---------- 한글 자모 (두벌식 키보드 조합 · 자모 단위 검색) ----------
const JUNG = ['ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ', 'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ'];
const JONG = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
// 겹모음·겹받침 ↔ 구성 자모
const PAIRS = {
  ㅘ: 'ㅗㅏ', ㅙ: 'ㅗㅐ', ㅚ: 'ㅗㅣ', ㅝ: 'ㅜㅓ', ㅞ: 'ㅜㅔ', ㅟ: 'ㅜㅣ', ㅢ: 'ㅡㅣ',
  ㄳ: 'ㄱㅅ', ㄵ: 'ㄴㅈ', ㄶ: 'ㄴㅎ', ㄺ: 'ㄹㄱ', ㄻ: 'ㄹㅁ', ㄼ: 'ㄹㅂ', ㄽ: 'ㄹㅅ', ㄾ: 'ㄹㅌ', ㄿ: 'ㄹㅍ', ㅀ: 'ㄹㅎ', ㅄ: 'ㅂㅅ',
};
const JOIN = Object.fromEntries(Object.entries(PAIRS).map(([k, v]) => [v, k]));
const isVowel = (ch) => JUNG.includes(ch);
const isConsonant = (ch) => CHO.includes(ch) || (JONG.includes(ch) && ch !== '');

/** 자판으로 누른 자모 나열을 글자로 조합한다. 예) ['ㅎ','ㅗ','ㅏ','ㅈ','ㅏ','ㅇ'] → '화장' */
function composeHangul(keys) {
  let out = '';
  let cur = null; // { cho, jung, jong }
  const flush = () => {
    if (!cur) return;
    if (cur.cho && cur.jung) {
      out += String.fromCharCode(0xac00 + (CHO.indexOf(cur.cho) * 21 + JUNG.indexOf(cur.jung)) * 28 + JONG.indexOf(cur.jong || ''));
    } else out += cur.cho || cur.jung;
    cur = null;
  };
  for (const k of keys) {
    if (isConsonant(k)) {
      if (cur?.cho && cur.jung && !cur.jong && JONG.includes(k)) cur.jong = k;
      else if (cur?.jong && JOIN[cur.jong + k]) cur.jong = JOIN[cur.jong + k];
      else { flush(); cur = { cho: k }; }
    } else if (isVowel(k)) {
      if (cur?.cho && !cur.jung) cur.jung = k;
      else if (cur?.jung && !cur.jong && JOIN[cur.jung + k]) cur.jung = JOIN[cur.jung + k];
      else if (cur?.jong) {
        // 받침이 다음 글자의 초성으로 넘어간다 (겹받침은 뒤 자음만)
        const [keep, move] = PAIRS[cur.jong] ? [...PAIRS[cur.jong]] : ['', cur.jong];
        cur.jong = keep;
        flush();
        cur = { cho: move, jung: k };
      } else { flush(); cur = { jung: k }; }
    } else { flush(); out += k; }
  }
  flush();
  return out;
}

/** 글자를 자모로 풀어 쓴다. '화장' → 'ㅎㅗㅏㅈㅏㅇ' (입력 중인 글자도 찾을 수 있게) */
const jamo = (s) =>
  [...s].map((ch) => {
    const c = ch.charCodeAt(0) - 0xac00;
    if (c < 0 || c > 11171) return PAIRS[ch] || ch;
    const jung = JUNG[Math.floor(c / 28) % 21];
    const jong = JONG[c % 28];
    return CHO[Math.floor(c / 588)] + (PAIRS[jung] || jung) + (PAIRS[jong] || jong);
  }).join('');

function matches(fac, q) {
  if (!q) return true;
  const hay = norm(`${fac.name}|${fac.name_en || ''}|${fac.category || ''}|${fac.category_en || ''}|${fac.room_no}|${fac.keywords}`);
  if (hay.includes(q)) return true;
  if (isChosungOnly(q)) return chosung(norm(`${fac.name}|${fac.keywords}`)).includes(q);
  return jamo(hay).includes(jamo(q));
}

/** 재생 항목의 기간/요일/시간대 조건 확인 */
function isItemActive(it, d = new Date()) {
  const day = todayStr(d);
  if (it.start_date && day < it.start_date) return false;
  if (it.end_date && day > it.end_date) return false;
  if (it.weekdays && !it.weekdays.split(',').map(Number).includes(d.getDay())) return false;
  if (it.start_time && it.end_time) {
    const t = nowHM(d);
    const inWin = it.start_time <= it.end_time ? t >= it.start_time && t < it.end_time : t >= it.start_time || t < it.end_time;
    if (!inWin) return false;
  }
  return true;
}

const isWindowActive = (n, d = new Date()) => {
  const t = `${todayStr(d)}T${nowHM(d)}`;
  return (!n.start_at || n.start_at <= t) && (!n.end_at || n.end_at > t);
};

// ---------- 홍보 사이니지 ----------
const stage = $('#stage');
const sig = { idx: -1, token: 0, timer: null, current: null, item: null };

function activeItems() {
  return (state.config?.playlist || []).filter((it) => isItemActive(it));
}

function stopSignage() {
  sig.token++;
  clearTimeout(sig.timer);
  stage.querySelectorAll('video').forEach((v) => v.pause());
}

function startSignage() {
  stopSignage();
  if (state.mode !== 'signage' || state.blocked) return;
  showNext();
}

function showFallback(token) {
  const b = state.config?.buildings?.find((x) => x.id === state.config.kiosk.building_id) || state.config?.buildings?.[0];
  const el = h('div', { class: 'slide fallback' },
    h('h1', {}, b?.name || state.config?.kiosk?.name || '건물 안내'),
    h('div', { class: 'big-clock', 'data-clock': 'big' }),
    h('div', { class: 'muted' }, state.config?.kiosk?.location || ''));
  swapSlide(el, 'fade');
  sig.item = null;
  // 재생 가능한 콘텐츠가 생겼는지 주기적으로 다시 확인한다.
  sig.timer = setTimeout(() => token === sig.token && showNext(), 30000);
  renderClock();
}

function showNext() {
  const token = ++sig.token;
  clearTimeout(sig.timer);
  const list = activeItems();
  if (!list.length) return showFallback(token);
  sig.idx = (sig.idx + 1) % list.length;
  const item = list[sig.idx];
  const advance = (delay = 0) => {
    clearTimeout(sig.timer);
    sig.timer = setTimeout(() => token === sig.token && showNext(), delay);
  };
  const fail = () => {
    state.errors++;
    advance(1000);
  };

  if (item.type === 'video') {
    const v = h('video', { playsinline: true, preload: 'auto' });
    v.muted = item.muted !== 0;
    v.src = mediaUrl(item.filename);
    const el = h('div', { class: 'slide' }, v);
    let shown = false;
    const reveal = () => {
      if (shown || token !== sig.token) return;
      shown = true;
      swapSlide(el);
      v.play().catch(() => {
        // 자동재생 정책으로 막히면 음소거 후 재시도
        v.muted = true;
        v.play().catch(fail);
      });
      // 영상이 멈춰 'ended' 가 오지 않는 경우를 대비한 안전장치
      const limit = Number.isFinite(v.duration) && v.duration > 0 ? (v.duration + 10) * 1000 : 30 * 60 * 1000;
      advance(limit);
    };
    v.addEventListener('loadeddata', reveal, { once: true });
    v.addEventListener('ended', () => token === sig.token && showNext());
    v.addEventListener('error', fail, { once: true });
    sig.timer = setTimeout(() => (shown ? null : fail()), 15000);
  } else {
    const img = h('img', { alt: item.title || '' });
    const el = h('div', { class: 'slide' }, img);
    img.onload = () => {
      if (token !== sig.token) return;
      swapSlide(el);
      const secs = item.duration || state.config.kiosk.image_duration || 5;
      advance(secs * 1000);
      preloadNext(list);
    };
    img.onerror = fail;
    img.src = mediaUrl(item.filename);
  }
  sig.item = item;
}

function preloadNext(list) {
  const next = list[(sig.idx + 1) % list.length];
  if (next && next.type === 'image') new Image().src = mediaUrl(next.filename);
}

function swapSlide(el, forced) {
  const transition = forced || state.config?.transition || 'slide';
  const old = sig.current;
  sig.current = el;
  if (!old || transition === 'none') {
    fill(stage, el);
    return;
  }
  if (transition === 'fade') {
    el.classList.add('t-fade', 'fade-in-start');
    stage.append(el);
    el.getBoundingClientRect();
    el.classList.remove('fade-in-start');
  } else {
    el.classList.add('t-slide', 'enter-right');
    old.classList.add('t-slide');
    stage.append(el);
    el.getBoundingClientRect();
    el.classList.remove('enter-right');
    old.classList.add('exit-left');
  }
  setTimeout(() => {
    old.querySelector('video')?.pause();
    old.remove();
  }, 900);
}

// ---------- 모드 전환 ----------
function goDirectory() {
  if (state.config?.kiosk.mode !== 'interactive' || state.blocked) return;
  state.mode = 'directory';
  state.lastTouch = Date.now();
  stopSignage();
  resetDirectory();
  $('#signage').hidden = true;
  $('#directory').hidden = false;
  renderDirectory();
}

function goSignage() {
  state.mode = 'signage';
  if (en()) setLang('ko');
  closeDetail();
  setKeypad(false);
  $('#directory').hidden = true;
  $('#signage').hidden = false;
  document.activeElement?.blur?.();
  startSignage();
}

function homeFloorId(b) {
  const k = state.config.kiosk;
  const floors = b?.floors || [];
  return (floors.find((f) => f.id === k.floor_id) || floors.find((f) => f.level === 1) || floors[0])?.id ?? null;
}

function resetDirectory() {
  const cfg = state.config;
  const home = cfg.buildings.find((b) => b.id === cfg.kiosk.building_id) || cfg.buildings[0];
  state.buildingId = home?.id ?? null;
  state.floorId = homeFloorId(home);
  state.view = 'floor';
  state.query = '';
  typed = [];
  state.category = null;
  $('#search').value = '';
  $('#search-clear').hidden = true;
}

// ---------- 층별 안내 렌더링 ----------
const currentBuilding = () => state.config.buildings.find((b) => b.id === state.buildingId);
const currentFloor = () => currentBuilding()?.floors.find((f) => f.id === state.floorId);
// 검색어가 있거나 [전체]/분류를 고른 상태면 목록을 보여준다.
const listMode = () => !!state.query || state.view === 'list';

function findFacility(id) {
  for (const b of state.config.buildings) for (const f of b.floors) {
    const fac = f.facilities.find((x) => x.id === id);
    if (fac) return { b, f, fac };
  }
  return null;
}

function findFloor(floorId) {
  for (const b of state.config.buildings) {
    const f = b.floors.find((x) => x.id === floorId);
    if (f) return { b, f };
  }
  return null;
}

function renderDirectory() {
  const cfg = state.config;
  const k = cfg.kiosk;
  const b = currentBuilding();

  // 동 탭 (동이 하나면 숨김)
  const tabs = $('#building-tabs');
  tabs.hidden = cfg.buildings.length < 2;
  fill(tabs, cfg.buildings.length > 1 && cfg.buildings.map((x) =>
    h('button', {
      class: `tab ${x.id === state.buildingId ? 'active' : ''}`,
      onclick: () => {
        // 동을 바꿔도 보던 방식(층/전체/분류)은 유지한다.
        state.buildingId = x.id;
        state.floorId = homeFloorId(x);
        clearSearch(false);
        renderDirectory();
      },
    }, nm(x))));

  // 층 버튼: 왼쪽부터 낮은 층 → 높은 층 (B1 1F 2F 3F)
  fill($('#floor-list'),
    [...(b?.floors || [])].sort((x, y) => x.level - y.level).map((f) =>
      h('button', {
        class: `floor-btn ${f.id === state.floorId && !listMode() ? 'active' : ''}`,
        onclick: () => {
          state.view = 'floor';
          state.floorId = f.id;
          state.category = null;
          clearSearch(false);
          renderDirectory();
        },
      },
      h('b', {}, f.name),
      h('span', {}, floorDesc(f) || T().floorCount(f.facilities.length)),
      f.id === k.floor_id ? h('em', { class: 'here-tag' }, T().hereTag) : null)),
    !b?.floors.length ? h('div', { class: 'empty' }, T().noFloors) : null);

  renderChips();
  if (listMode()) renderList();
  else renderFloor();
}

function renderChips() {
  // 관리자가 정한 분류 순서대로, 지금 보고 있는 범위에 시설이 있는 분류만 보여준다.
  const used = new Set(listScope().flatMap((b) => b.floors.flatMap((f) => f.facilities.map((x) => x.category_id))));
  const inList = state.view === 'list';
  const pick = (id) => {
    state.view = 'list';
    state.category = id;
    renderDirectory();
  };
  fill($('#category-chips'),
    h('button', { class: `chip ${inList && !state.category ? 'active' : ''}`, onclick: () => pick(null) }, T().all),
    (state.config.categories || []).filter((c) => used.has(c.id)).map((c) => h('button', {
      class: `chip ${inList && state.category === c.id ? 'active' : ''}`,
      // 같은 분류를 다시 누르면 [전체]로
      onclick: () => pick(inList && state.category === c.id ? null : c.id),
    }, iconEl(c.icon), nm(c))));
}

/** 운영 상태 표시(운영 중 / 곧 종료 / 운영 종료 …). 1분마다 refreshStatus() 가 글자만 바꾼다. */
function statusBadge(fac) {
  const st = statusAt(fac.hours_rule, new Date(), state.lang);
  return st ? h('span', { class: `status ${st.state}`, 'data-fid': fac.id }, st.label) : null;
}
function refreshStatus() {
  document.querySelectorAll('.status[data-fid]').forEach((el) => {
    const st = statusAt(findFacility(Number(el.dataset.fid))?.fac.hours_rule, new Date(), state.lang);
    if (!st) return;
    el.className = `status ${st.state}`;
    el.textContent = st.label;
  });
}

function facCard(fac) {
  return h('button', { class: 'fac', onclick: () => openDetail(fac.id) },
    h('div', { class: 'row' }, h('b', {}, nm(fac)), catTag(fac)),
    h('div', { class: 'meta' }, statusBadge(fac),
      [fac.room_no ? T().room(fac.room_no) : null, fac.hours_rule ? todayText(fac.hours_rule, new Date(), state.lang) : fac.hours].filter(Boolean).join(' · ') || ' '));
}

function renderFloor() {
  const f = currentFloor();
  const b = currentBuilding();
  $('#floor-name').textContent = f ? `${nm(b)} ${f.name}` : T().noFloorInfo;
  $('#floor-desc').textContent = f ? floorDesc(f) || '' : '';
  const list = $('#facility-list');
  if (!f) {
    $('#map-wrap').hidden = true;
    list.hidden = false;
    fill(list, h('div', { class: 'empty' }, T().noData));
    return;
  }
  renderMap(f);
  // 도면이 있으면 도면만, 없으면 그 자리에 시설 목록을 보여준다.
  list.hidden = !!f.map_image;
  if (!f.map_image) fill(list, f.facilities.map(facCard), !f.facilities.length ? h('div', { class: 'empty' }, T().floorEmpty) : null);
}

function renderMap(f) {
  const wrap = $('#map-wrap');
  wrap.hidden = !f.map_image;
  if (!f.map_image) return;
  const k = state.config.kiosk;
  fill($('#map'),
    h('img', { src: mediaUrl(f.map_image), alt: T().mapAlt(f.name), draggable: 'false' }),
    f.facilities.filter((x) => x.pos_x != null && x.pos_y != null).map((x) =>
      h('button', { class: 'pin', style: `left:${x.pos_x}%;top:${x.pos_y}%`, onclick: () => openDetail(x.id) }, h('span', {}, nm(x)), h('i'))),
    k.floor_id === f.id && k.pos_x != null
      ? h('div', { class: 'pin here', style: `left:${k.pos_x}%;top:${k.pos_y}%` }, h('span', {}, T().youAreHere), h('i'))
      : null);
}

// 목록 범위: 검색어가 있으면 모든 동, 아니면 지금 보고 있는 동
const listScope = () => (state.query ? state.config.buildings : [currentBuilding()].filter(Boolean));

/** [전체]·분류·검색 결과를 같은 모양(층별로 묶은 시설 목록)으로 보여준다. */
function renderList() {
  const q = norm(state.query);
  const scope = listScope();
  $('#map-wrap').hidden = true;
  $('#facility-list').hidden = false;
  const groups = [];
  let total = 0;
  for (const b of scope) for (const f of b.floors) {
    const hits = f.facilities.filter((x) => matches(x, q) && (!state.category || x.category_id === state.category));
    if (!hits.length) continue;
    total += hits.length;
    groups.push(h('h3', { class: 'result-floor' }, scope.length > 1 ? `${nm(b)} ${f.name}` : f.name), hits.map(facCard));
  }
  const cat = state.config.categories?.find((c) => c.id === state.category);
  const catName = cat ? nm(cat) : '';
  const where = scope.length > 1 ? T().allBuildings : nm(scope[0]);
  $('#floor-name').textContent = state.query ? T().results(total) : T().placeCount(catName || T().allPlaces, total);
  $('#floor-desc').textContent = [where, state.query && `“${state.query}”`, state.query && catName].filter(Boolean).join(' · ');
  fill($('#facility-list'), groups,
    !total ? h('div', { class: 'empty' }, state.query ? T().noResults : T().noPlaces) : null);
}

function openDetail(id) {
  const found = findFacility(id);
  if (!found) return;
  const { b, f, fac } = found;
  const desc = (en() && fac.description_en) || fac.description;
  const rows = [
    [T().location, `${nm(b)} ${f.name}${fac.room_no ? ` ${T().room(fac.room_no)}` : ''}`],
    [T().category, catLabel(fac)],
    // 요일별 운영시간 + 관리자가 적은 메모(예: 점심시간)
    [T().hours, [summarizeRule(fac.hours_rule, state.lang), fac.hours].filter(Boolean).join('\n')],
    [T().phone, fac.phone],
  ].filter(([, v]) => v);
  fill($('#detail-body'),
    h('div', { class: 'detail-tags' }, catTag(fac), statusBadge(fac)),
    h('h2', { class: 'detail-title' }, nm(fac)),
    desc ? h('p', { class: 'muted', style: 'white-space:pre-line' }, desc) : null,
    h('dl', { class: 'detail-grid' }, rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', { style: 'white-space:pre-line' }, v)])));
  $('#detail').hidden = false;
}

function closeDetail() {
  $('#detail').hidden = true;
}

// ---------- 검색 / 화상 키보드 ----------
// 화상 키보드로 누른 키를 그대로 모아 두고, 검색어는 이걸 조합해서 만든다(⌫는 자모 하나씩 지움).
let typed = [];
const kb = { shift: false, english: false };

function setQuery(q) {
  state.query = q;
  $('#search').value = q;
  $('#search-clear').hidden = !q;
  renderDirectory();
}
function clearSearch(render = true) {
  typed = [];
  state.query = '';
  $('#search').value = '';
  $('#search-clear').hidden = true;
  if (render) renderDirectory();
}
function setKeypad(open) {
  $('#keypad').hidden = !open;
}
function typeKeys(next) {
  typed = next;
  setQuery(composeHangul(typed));
}

const KB_ROWS = {
  ko: ['1234567890', 'ㅂㅈㄷㄱㅅㅛㅕㅑㅐㅔ', 'ㅁㄴㅇㄹㅎㅗㅓㅏㅣ', 'ㅋㅌㅊㅍㅠㅜㅡ'],
  en: ['1234567890', 'QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'],
};
const KO_SHIFT = { ㅂ: 'ㅃ', ㅈ: 'ㅉ', ㄷ: 'ㄸ', ㄱ: 'ㄲ', ㅅ: 'ㅆ', ㅐ: 'ㅒ', ㅔ: 'ㅖ' };

function buildKeypad() {
  const rows = KB_ROWS[kb.english ? 'en' : 'ko'].map((r) => [...r]);
  const label = (k) => (kb.shift && !kb.english ? KO_SHIFT[k] || k : k);
  const key = (k) => h('button', {
    class: 'key',
    onclick: () => {
      typeKeys([...typed, label(k)]);
      if (kb.shift) { kb.shift = false; buildKeypad(); }
    },
  }, label(k));
  const special = (cls, text, onclick, attrs = {}) => h('button', { class: `key ${cls}`, onclick, ...attrs }, text);

  fill($('#keypad'),
    h('div', { class: 'kb-row' }, rows[0].map(key)),
    h('div', { class: 'kb-row' }, rows[1].map(key)),
    h('div', { class: 'kb-row indent' }, rows[2].map(key)),
    h('div', { class: 'kb-row' },
      kb.english
        ? h('span', { class: 'key-gap' })
        : special('fn shift', '⇧', () => { kb.shift = !kb.shift; buildKeypad(); }, { 'aria-pressed': String(kb.shift) }),
      rows[3].map(key),
      special('fn', '⌫', () => typeKeys(typed.slice(0, -1)))),
    h('div', { class: 'kb-row' },
      special('fn', kb.english ? '한글' : 'ABC', () => { kb.english = !kb.english; kb.shift = false; buildKeypad(); }),
      special('space', T().space, () => typeKeys([...typed, ' '])),
      special('fn', T().clear, () => clearSearch()),
      special('fn', T().close, () => { setKeypad(false); $('#search').blur(); })));
}

// ---------- 하단 공지 ----------
function renderNotices() {
  const notices = (state.config?.notices || []).filter((n) => isWindowActive(n));
  const text = notices.map((n) => (n.body ? `${n.title} — ${n.body}` : n.title)).join('     •     ');
  document.body.classList.toggle('has-ticker', !!text);
  $('#ticker').hidden = !text;
  const span = $('#ticker-text');
  if (span.textContent !== text) {
    span.textContent = text;
    span.style.animationDuration = `${Math.max(15, text.length * 0.28)}s`;
  }
}

// ---------- 시계 ----------
function renderClock() {
  const d = new Date();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const date = en()
    ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', weekday: 'short' })
    : `${d.getMonth() + 1}월 ${d.getDate()}일 (${'일월화수목금토'[d.getDay()]})`;
  fill($('#clock'), time, h('small', {}, date));
  document.querySelectorAll('[data-clock="big"]').forEach((el) => (el.textContent = time));
}

// ---------- 서버 통신 ----------
function overlay(...content) {
  const el = $('#overlay-msg');
  el.hidden = !content.length;
  fill(el, content);
}
const maintenance = () => overlay(h('h1', {}, '점검 중'), h('p', { class: 'muted' }, '잠시 후 다시 이용해 주세요.'));

function block() {
  state.blocked = true;
  stopSignage();
  if (state.mode === 'directory') goSignage();
  maintenance();
}

function applyConfig(cfg) {
  const prev = state.config;
  state.config = cfg;
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cfg)); } catch {}
  document.title = `${cfg.kiosk.name} · 건물 안내`;
  $('#signage-hint').hidden = cfg.kiosk.mode !== 'interactive';

  if (!cfg.kiosk.enabled) return block();
  const wasBlocked = state.blocked;
  state.blocked = false;
  overlay();

  if (cfg.kiosk.mode !== 'interactive' && state.mode === 'directory') goSignage();
  if (state.mode === 'directory') {
    if (!currentBuilding() || !currentFloor()) resetDirectory();
    renderDirectory();
  }
  renderNotices();
  // 재생 중인 항목은 끊지 않고, 처음 로드됐거나 점검/빈 화면에서 돌아온 경우에만 즉시 시작한다.
  if (state.mode === 'signage' && (!prev || wasBlocked || !sig.item)) startSignage();
}

async function loadConfig() {
  try {
    const r = await fetch(`/api/k/${encodeURIComponent(code)}/config`, { cache: 'no-store' });
    if (r.status === 404) {
      // 등록되지 않은 키오스크
      state.config = null;
      return block();
    }
    if (!r.ok) throw new Error(r.status);
    const cfg = await r.json();
    // 처음 켜졌을 때는 그 이전에 보낸 원격 명령을 무시한다.
    if (!lastCommandId) setLastCommand(cfg.command_clock || Date.now());
    if (cfg.version !== state.config?.version || state.blocked) applyConfig(cfg);
  } catch {
    if (!state.config) {
      // 서버가 꺼져 있어도 마지막으로 받은 설정으로 계속 운영한다.
      try {
        const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
        if (cached) applyConfig(cached);
      } catch {}
    }
  }
}

// ---------- 원격 명령 ----------
let lastCommandId = Number(localStorage.getItem(CMD_KEY)) || 0;
function setLastCommand(id) {
  lastCommandId = id;
  try { localStorage.setItem(CMD_KEY, String(id)); } catch {}
}

function runCommand(cmd) {
  // SSE 와 주기 확인 양쪽으로 같은 명령이 올 수 있으므로 번호로 한 번만 실행한다.
  if (cmd.id && cmd.id <= lastCommandId) return;
  if (cmd.id) setLastCommand(cmd.id);
  if (cmd.type === 'reload') location.reload();
  else if (cmd.type === 'config') loadConfig();
}

// ---------- 실시간 연결(SSE) + 막혔을 때 주기 확인 ----------
let lastSseSignal = 0; // 서버가 보낸 hello/ping 을 실제로 받은 시각

function connectEvents() {
  const es = new EventSource(`/api/k/${encodeURIComponent(code)}/events`);
  const alive = () => (lastSseSignal = Date.now());
  // 프록시가 응답을 버퍼링하면 onopen 은 와도 이벤트는 오지 않으므로, 서버 신호를 받았을 때만 살아 있다고 본다.
  es.addEventListener('hello', () => { alive(); loadConfig(); });
  es.addEventListener('ping', alive);
  es.addEventListener('config', () => { alive(); loadConfig(); });
  es.addEventListener('reload', (e) => { alive(); runCommand({ type: 'reload', ...JSON.parse(e.data || '{}') }); });
  // 미등록(404) 등으로 연결이 완전히 끊기면 브라우저가 재시도하지 않으므로 직접 다시 연결한다.
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) setTimeout(connectEvents, 30000);
  };
}

async function poll() {
  if (Date.now() - lastSseSignal < 40000) return; // SSE 가 정상이면 확인하지 않는다
  try {
    const r = await fetch(`/api/k/${encodeURIComponent(code)}/poll?since=${lastCommandId}`, { cache: 'no-store' });
    if (r.status === 404) return loadConfig();
    if (!r.ok) return;
    const { version, commands } = await r.json();
    if (version !== state.config?.version) await loadConfig();
    commands.forEach(runCommand);
  } catch {}
}

async function heartbeat() {
  if (PREVIEW) return;
  try {
    await fetch(`/api/k/${encodeURIComponent(code)}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: state.blocked ? 'blocked' : state.mode,
        current: sig.item?.title || '',
        version: state.config?.version,
        screen: `${screen.width}x${screen.height}`,
        uptime: Math.round((Date.now() - BOOT) / 1000),
        errors: state.errors,
      }),
    });
  } catch {}
}

/** 언어를 바꾸고 화면 글자를 다시 그린다. 검색 키보드도 그 언어 자판으로 연다. */
function setLang(lang) {
  state.lang = lang;
  document.documentElement.lang = lang;
  const g = en() ? 'A' : '가';
  fill($('#btn-large'), g, h('small', {}, g), ` ${T().large}`);
  $('#btn-home').textContent = T().home;
  $('#btn-lang').textContent = T().lang;
  $('#search').placeholder = T().search;
  $('.ticker-label').textContent = en() ? 'Notice' : '공지';
  kb.english = lang === 'en';
  kb.shift = false;
  buildKeypad();
  renderClock();
  if (state.mode === 'directory') {
    closeDetail();
    renderDirectory();
  }
}

// ---------- 이벤트 바인딩 ----------
$('#signage').addEventListener('pointerdown', goDirectory);
$('#btn-home').addEventListener('click', goSignage);
$('#btn-lang').addEventListener('click', () => setLang(en() ? 'ko' : 'en'));
$('#btn-large').addEventListener('click', (e) => {
  const on = document.body.classList.toggle('large');
  e.currentTarget.setAttribute('aria-pressed', String(on));
});
// 검색창을 누르면 화상 키보드를 연다.
$('#search').addEventListener('pointerdown', () => setKeypad(true));
$('#search').addEventListener('focus', () => setKeypad(true));
// 검색창·키패드 밖을 누르면 키패드를 닫는다.
$('#directory').addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.search-box, #keypad')) setKeypad(false);
});
// 물리 키보드로 직접 입력한 경우: 입력된 글자를 그대로 이어서 쓴다.
$('#search').addEventListener('input', (e) => { typed = [...e.target.value]; setQuery(e.target.value); });
$('#search-clear').addEventListener('click', () => clearSearch());
$('#detail').addEventListener('click', (e) => {
  if (e.target.id === 'detail' || e.target.closest('.modal-close')) closeDetail();
});
// 화면을 누르는 것뿐 아니라 끌어서 스크롤하는 동안에도 '사용 중'으로 본다.
// (리눅스 터치스크린은 기기·드라이버에 따라 touch/mouse/pointer 중 일부만 보내므로 모두 듣는다)
const markActive = () => (state.lastTouch = Date.now());
['pointerdown', 'pointermove', 'touchstart', 'touchmove', 'mousedown', 'wheel', 'keydown', 'input'].forEach((t) =>
  document.addEventListener(t, (e) => {
    // 마우스를 그냥 올려 둔 상태의 움직임은 조작으로 보지 않는다(누른 채 움직일 때만).
    if (t === 'pointermove' && e.pointerType === 'mouse' && !e.buttons) return;
    markActive();
  }, { capture: true, passive: true }));
document.addEventListener('scroll', markActive, { capture: true, passive: true });
document.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('error', () => state.errors++);

setInterval(() => {
  renderClock();
  // 일정 시간 조작이 없으면 홍보 화면으로 복귀
  if (state.mode === 'directory' && Date.now() - state.lastTouch > (state.config?.kiosk.idle_timeout || 30) * 1000) goSignage();
}, 1000);
setInterval(renderNotices, 15000);
setInterval(() => state.mode === 'directory' && refreshStatus(), 60000);
setInterval(heartbeat, 30000);
setInterval(loadConfig, PREVIEW ? 10000 : 5 * 60 * 1000);
// 미등록 상태면 관리자 등록을 빨리 반영하도록 30초마다 확인
setInterval(() => !state.config && state.blocked && loadConfig(), 30000);
// 장시간 구동 시 메모리 누수 방지: 새벽 4시대 홍보 모드일 때 하루 한 번 새로고침
setInterval(() => {
  if (Date.now() - BOOT > 6 * 3600e3 && new Date().getHours() === 4 && state.mode === 'signage') location.reload();
}, 60000);

buildKeypad();
renderClock();
await loadConfig();
if (!PREVIEW) {
  connectEvents();
  heartbeat();
  setInterval(poll, POLL_MS);
}
