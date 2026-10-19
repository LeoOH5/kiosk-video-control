// 키오스크 중앙관리 화면 (빌드 없이 동작하는 단일 페이지 앱)
import { DAY_KEYS, normalizeRule, summarizeRule } from '/shared/hours.js';
import { ICONS, iconSvg } from '/shared/icons.js';

const $ = (s, root = document) => root.querySelector(s);
/** null/false 를 걸러내고 자식 요소를 교체한다(replaceChildren 은 null 을 'null' 글자로 넣는다). */
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'selected' || k === 'disabled' || k === 'multiple') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid);
  return el;
};

// ---------- API ----------
async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(`/api${url}`, opts);
  if (r.status === 401 && !url.startsWith('/auth')) {
    showLogin();
    throw new Error('로그인이 필요합니다.');
  }
  const data = r.headers.get('content-type')?.includes('json') ? await r.json() : null;
  if (!r.ok) throw new Error(data?.error || `요청 실패 (${r.status})`);
  return data;
}
const GET = (u) => api('GET', u);
const POST = (u, b) => api('POST', u, b ?? {});
const PUT = (u, b) => api('PUT', u, b);
const DEL = (u) => api('DELETE', u);

// ---------- UI 헬퍼 ----------
let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast ${isError ? 'error' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 4000 : 1800);
}
/** 비동기 작업을 실행하고 오류는 토스트로 보여준다. */
const run = (fn) => async (...a) => {
  try {
    return await fn(...a);
  } catch (e) {
    toast(e.message, true);
  }
};

const modalEl = $('#modal');
function openModal({ title, body, foot = [], wide = false, onClose }) {
  modalEl.className = `modal ${wide ? 'wide' : ''}`;
  modalEl.style.width = '';
  fill(modalEl, 
    h('div', { class: 'modal-head' }, h('h2', {}, title), h('button', { class: 'btn ghost small', type: 'button', onclick: closeModal }, '닫기')),
    h('div', { class: 'modal-body' }, body),
    foot.length ? h('div', { class: 'modal-foot' }, foot) : null
  );
  modalCleanup = onClose || null;
  if (!modalEl.open) modalEl.showModal();
}
// 닫힐 때 할 일. 'close' 이벤트는 백그라운드 탭에서 늦게 오므로 닫기 버튼에서는 직접 바로 실행한다.
let modalCleanup = null;
function runModalCleanup() {
  const fn = modalCleanup;
  modalCleanup = null;
  fn?.();
}
modalEl.addEventListener('close', runModalCleanup); // Esc 키로 닫은 경우
function closeModal() {
  if (modalEl.open) modalEl.close();
  runModalCleanup();
}
function confirmBox(message, { okText = '확인', danger = true } = {}) {
  return new Promise((resolve) => {
    let ok = false;
    openModal({
      title: '확인',
      body: h('p', { style: 'margin:0;white-space:pre-line' }, message),
      foot: [
        h('button', { class: 'btn', onclick: closeModal }, '취소'),
        h('button', { class: `btn ${danger ? 'danger solid' : 'primary'}`, onclick: () => { ok = true; closeModal(); } }, okText),
      ],
      onClose: () => resolve(ok),
    });
  });
}

function field(label, input, help) {
  return h('label', { class: 'field' }, h('span', {}, label, help ? h('small', {}, ` · ${help}`) : null), input);
}
const input = (name, value, attrs = {}) => h('input', { name, value: value ?? '', ...attrs });
const textarea = (name, value, attrs = {}) => {
  const t = h('textarea', { name, rows: 3, ...attrs });
  t.value = value ?? '';
  return t;
};
const select = (name, options, value, attrs = {}) =>
  h('select', { name, ...attrs }, options.map(([v, label]) => h('option', { value: v, selected: String(v) === String(value ?? '') }, label)));

function formValues(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked ? 1 : 0;
    else if (el.type === 'number') out[el.name] = el.value === '' ? null : Number(el.value);
    else out[el.name] = el.value.trim();
  }
  return out;
}

function timeAgo(utc) {
  if (!utc) return '기록 없음';
  const sec = (Date.now() - Date.parse(utc.replace(' ', 'T') + 'Z')) / 1000;
  if (sec < 60) return '방금';
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}시간 전`;
  return `${Math.floor(sec / 86400)}일 전`;
}
const fmtSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)}MB` : `${Math.round(b / 1024)}KB`);
/** 동영상 길이: 6초 / 1분 30초 / 2분 */
const fmtDur = (s) => {
  if (!s) return '';
  const t = Math.round(s), m = Math.floor(t / 60), sec = t % 60;
  return m ? `${m}분${sec ? ` ${sec}초` : ''}` : `${sec}초`;
};
const mediaUrl = (f) => `/uploads/${encodeURIComponent(f)}`;

function thumb(m) {
  return h('div', { class: 'thumb' },
    m.type === 'video' ? h('video', { src: mediaUrl(m.filename) + '#t=1', muted: true, preload: 'metadata' }) : h('img', { src: mediaUrl(m.filename), loading: 'lazy', alt: '' }),
    h('span', { class: `kind ${m.type}` }, m.type === 'video' ? `동영상 ${fmtDur(m.duration || m.media_duration)}`.trim() : '사진'));
}

/** 열 너비를 고정한 표: 상태·버튼 글자가 바뀌어도 열 비율이 흔들리지 않는다. 너비를 비운 열이 남는 폭을 나눠 갖는다. */
const colgroup = (...widths) => h('colgroup', {}, widths.map((w) => h('col', w ? { style: `width:${w}` } : {})));

function pageHead(title, desc, ...actions) {
  return h('div', { class: 'page-head' }, title ? h('div', {}, h('h1', {}, title), desc ? h('p', { class: 'muted' }, desc) : null) : null, h('div', { class: 'toolbar' }, actions));
}
// 메뉴 첫 화면: 왼쪽 메뉴에서 이미 어느 화면인지 보이므로 제목·설명 없이 버튼만 오른쪽에 둔다.
const menuHead = (...actions) => h('div', { class: 'page-head menu-head' }, h('div', { class: 'toolbar' }, actions));

// ---------- 라우터 ----------
const view = $('#view');
let refreshTimer = null;
const routes = {
  kiosks: renderKiosks,
  playlists: (id) => (id ? renderPlaylistEditor(id) : renderPlaylists()),
  media: renderMedia,
  buildings: renderBuildings,
  notices: renderNotices,
};

async function route() {
  clearInterval(refreshTimer);
  const [name = 'kiosks', id] = location.hash.replace(/^#\/?/, '').split('/');
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
  const fn = routes[name] || renderKiosks;
  try {
    await fn(id);
  } catch (e) {
    fill(view, h('div', { class: 'card empty-state' }, e.message));
  }
}
window.addEventListener('hashchange', route);

const statusBadge = (k) =>
  !k.enabled ? h('span', { class: 'badge warn dot' }, '비활성') : k.online ? h('span', { class: 'badge ok dot' }, '온라인') : h('span', { class: 'badge off dot' }, '오프라인');

// ---------- 키오스크 ----------
async function renderKiosks() {
  const draw = async () => {
    const kiosks = await GET('/kiosks');
    fill(view, 
      menuHead(
        h('button', { class: 'btn primary', onclick: () => kioskForm() }, '+ 키오스크 추가')),
      h('div', { class: 'card table-wrap' },
        kiosks.length
          ? h('table', { class: 'fixed-table', style: 'min-width:1040px' },
              colgroup(null, '180px', '130px', '170px', '120px', '340px'),
              h('thead', {}, h('tr', {}, ['이름 / 설치 위치', '상태', '건물(동)', '재생목록', '설정', ''].map((t) => h('th', {}, t)))),
              h('tbody', {}, kiosks.map((k) =>
                h('tr', {},
                  h('td', {}, h('b', {}, k.name), h('div', { class: 'muted' }, [k.location, k.floor_name].filter(Boolean).join(' · ') || '-'), h('code', { class: 'k' }, k.code)),
                  h('td', {}, statusBadge(k), h('div', { class: 'muted', style: 'margin-top:4px;font-size:14px' }, timeAgo(k.last_seen)),
                    k.last_status ? h('div', { class: 'muted', style: 'font-size:14px' }, `${k.last_status.mode === 'directory' ? '안내 사용 중' : k.last_status.mode === 'blocked' ? '점검 중 표시' : '홍보 재생'}${k.last_status.current ? ` · ${k.last_status.current}` : ''}`) : null),
                  h('td', {}, k.building_name || h('span', { class: 'muted' }, '미지정')),
                  h('td', {}, k.playlist_name || h('span', { class: 'muted' }, '미지정')),
                  h('td', { class: 'muted', style: 'font-size:14px' }, `대기복귀 ${k.idle_timeout}초`, h('br'), k.mode === 'interactive' ? '터치 가능' : '터치 불가'),
                  h('td', {}, h('div', { class: 'toolbar', style: 'justify-content:flex-end' },
                    h('button', { class: 'btn small', onclick: () => previewKiosk(k) }, '미리보기'),
                    h('button', { class: 'btn small', title: '키오스크 페이지 새로고침', onclick: run(() => command(k, 'reload')) }, '재시작'),
                    h('button', { class: 'btn small', onclick: () => kioskForm(k) }, '편집'),
                    h('button', { class: 'btn small', onclick: run(async () => { await POST(`/kiosks/${k.id}/duplicate`); toast('복제했습니다.'); draw(); }) }, '복제'),
                    h('button', { class: 'btn small danger', onclick: run(async () => {
                      if (!(await confirmBox(`'${k.name}' 키오스크를 삭제할까요?`))) return;
                      await DEL(`/kiosks/${k.id}`);
                      draw();
                    }) }, '삭제')))))))
          : h('div', { class: 'empty-state' }, '아직 키오스크가 없습니다. 오른쪽 위의 [키오스크 추가]로 등록하세요.'))
    );
  };
  window.__redrawKiosks = draw;
  await draw();
  refreshTimer = setInterval(run(draw), 15000);
}

// 키오스크 화면(세로 1080×1920)을 관리자 화면 안에서 같은 비율로 줄여 보여준다.
const KIOSK_W = 1080, KIOSK_H = 1920;
function previewKiosk(k) {
  const scale = Math.min((window.innerHeight - 260) / KIOSK_H, (Math.min(window.innerWidth, 720) - 80) / KIOSK_W);
  const frame = h('iframe', {
    src: `/k/${encodeURIComponent(k.code)}?preview=1`,
    title: `${k.name} 미리보기`,
    style: `width:${KIOSK_W}px;height:${KIOSK_H}px;border:0;transform:scale(${scale});transform-origin:0 0;display:block`,
  });
  const screen = h('div', { class: 'kiosk-screen', style: `width:${KIOSK_W * scale}px;height:${KIOSK_H * scale}px` }, frame);
  openModal({
    title: `미리보기 · ${k.name}`,
    body: h('div', { class: 'kiosk-preview' }, screen,
      h('p', { class: 'help' }, '세로 1080×1920 화면을 줄여서 보여줍니다. 클릭하면 실제 키오스크처럼 터치로 동작합니다. 설정을 바꾸면 10초 안에 반영됩니다.')),
    foot: [h('button', { class: 'btn', onclick: () => frame.contentWindow?.location.reload() }, '처음부터 다시')],
    // 닫으면 화면을 비워 동영상 소리 등이 계속 재생되지 않게 한다.
    onClose: () => frame.remove(),
  });
  modalEl.style.width = `${Math.max(KIOSK_W * scale + 60, 360)}px`;
}

async function command(k, type) {
  const r = await POST(`/kiosks/${k.id}/command`, { type });
  toast(r.online ? `${k.name}에 명령을 보냈습니다. (최대 10초 안에 실행)` : `${k.name}이(가) 오프라인입니다. 켜지면 2분 안의 명령은 실행됩니다.`, !r.online);
}

async function kioskForm(k = {}) {
  const [buildings, playlists] = await Promise.all([GET('/buildings'), GET('/playlists')]);
  const pos = { x: k.pos_x ?? null, y: k.pos_y ?? null };
  const floorSel = select('floor_id', [['', '선택 안 함']], k.floor_id);
  const mapBox = h('div');
  let floors = [];

  const loadFloors = async (bid, keep) => {
    floors = bid ? (await GET(`/buildings/${bid}/tree`)).floors : [];
    fill(floorSel, ...[['', '선택 안 함'], ...floors.map((f) => [f.id, f.name])].map(([v, l]) => h('option', { value: v, selected: keep && String(v) === String(k.floor_id ?? '') }, l)));
    drawMap();
  };
  const drawMap = () => {
    const f = floors.find((x) => String(x.id) === floorSel.value);
    if (!f?.map_image) {
      fill(mapBox, f ? h('p', { class: 'help' }, '이 층에는 도면이 없어 위치 핀을 지정할 수 없습니다. 시설 관리 메뉴에서 도면을 올려주세요.') : '');
      return;
    }
    const pin = pos.x != null ? h('div', { class: 'mpin me', style: `left:${pos.x}%;top:${pos.y}%` }, '현재 위치') : null;
    const others = f.facilities.filter((x) => x.pos_x != null).map((x) => h('div', { class: 'mpin other', style: `left:${x.pos_x}%;top:${x.pos_y}%` }, x.name));
    const ed = h('div', { class: 'map-editor' }, h('img', { src: mediaUrl(f.map_image), draggable: 'false' }), others, pin);
    ed.addEventListener('click', (e) => {
      const r = ed.getBoundingClientRect();
      pos.x = +(((e.clientX - r.left) / r.width) * 100).toFixed(2);
      pos.y = +(((e.clientY - r.top) / r.height) * 100).toFixed(2);
      drawMap();
    });
    fill(mapBox, h('p', { class: 'help', style: 'margin-bottom:6px' }, '도면을 클릭해 키오스크의 “현재 위치”를 지정하세요.'), ed,
      pos.x != null ? h('button', { type: 'button', class: 'btn small', style: 'margin-top:6px', onclick: () => { pos.x = pos.y = null; drawMap(); } }, '위치 지우기') : null);
  };
  floorSel.addEventListener('change', () => { pos.x = pos.y = null; drawMap(); });
  const buildingSel = select('building_id', [['', '선택 안 함'], ...buildings.map((b) => [b.id, b.name])], k.building_id, { onchange: (e) => loadFloors(e.target.value, false) });

  const form = h('form', { class: 'form' },
    h('div', { class: 'row2' },
      field('키오스크 이름', input('name', k.name, { required: true, placeholder: '예: A동 1층 로비' })),
      field('키오스크 코드', input('code', k.code, { placeholder: '비우면 자동 생성', pattern: '[A-Za-z0-9_-]{2,40}' }), '접속 주소에 사용')),
    h('div', { class: 'row2' },
      field('설치 건물(동)', buildingSel),
      field('설치 위치 설명', input('location', k.location, { placeholder: '예: 정문 엘리베이터 앞' }))),
    field('설치 층', floorSel, '“현위치” 표시에 사용'),
    mapBox,
    h('div', { class: 'row2' },
      field('재생목록', select('playlist_id', [['', '없음(시계 화면)'], ...playlists.map((p) => [p.id, `${p.name} (${p.item_count}개)`])], k.playlist_id)),
      field('동작 모드', select('mode', [['interactive', '터치 가능'], ['signage', '터치 불가']], k.mode || 'interactive'))),
    field('안내 화면 대기 복귀(초)', input('idle_timeout', k.idle_timeout ?? 30, { type: 'number', min: 10, max: 3600, required: true }), '조작이 없으면 홍보 화면으로'),
    field('메모', textarea('memo', k.memo, { rows: 2, placeholder: '설치 업체, 장비 S/N, 담당자 등' }))
  );
  form.addEventListener('submit', run(async (e) => {
    e.preventDefault();
    const data = { ...formValues(form), pos_x: pos.x, pos_y: pos.y };
    if (k.id) await PUT(`/kiosks/${k.id}`, data);
    else {
      const r = await POST('/kiosks', data);
      toast(`등록 완료 · 주소: /k/${r.code}`);
    }
    closeModal();
    window.__redrawKiosks?.();
  }));
  openModal({
    title: k.id ? '키오스크 편집' : '키오스크 추가',
    body: form,
    foot: [h('button', { class: 'btn', onclick: closeModal }, '취소'), h('button', { class: 'btn primary', onclick: () => form.requestSubmit() }, '저장')],
  });
  if (k.building_id) await loadFloors(k.building_id, true);
}

// ---------- 재생목록 ----------
async function renderPlaylists() {
  const lists = await GET('/playlists');
  fill(view, 
    menuHead(
      h('button', { class: 'btn primary', onclick: () => playlistForm() }, '+ 재생목록 만들기')),
    lists.length
      ? h('div', { class: 'grid cols-2' }, lists.map((p) =>
          h('div', { class: 'card' },
            h('div', { class: 'page-head', style: 'margin:0 0 8px' }, h('div', {}, h('h2', { style: 'margin:0' }, p.name), h('p', { class: 'muted', style: 'min-height:1.5em' }, p.description || '')), h('span', { class: 'badge' }, `${p.item_count}개 항목`)),
            h('p', { class: 'muted', style: 'font-size:15px' }, '사용 키오스크: ', p.kiosk_names || '없음'),
            h('div', { class: 'toolbar' },
              h('a', { class: 'btn primary small', href: `#/playlists/${p.id}` }, '콘텐츠 편집'),
              h('button', { class: 'btn small', onclick: () => playlistForm({ copy_from: p.id, name: `${p.name} 복사본` }) }, '복제'),
              h('button', { class: 'btn small danger', onclick: run(async () => {
                if (!(await confirmBox(`'${p.name}' 재생목록을 삭제할까요?\n연결된 키오스크는 재생목록 없음 상태가 됩니다.`))) return;
                await DEL(`/playlists/${p.id}`);
                renderPlaylists();
              }) }, '삭제')))))
      : h('div', { class: 'card empty-state' }, '재생목록이 없습니다.')
  );
}

function playlistForm(init = {}) {
  const form = h('form', { class: 'form' },
    field('이름', input('name', init.name, { required: true, placeholder: '예: 본관 로비 홍보' })),
    field('설명', input('description', '')),
    field('전환 효과', select('transition', [['slide', '옆으로 밀기'], ['fade', '페이드'], ['none', '없음']], 'slide')));
  form.addEventListener('submit', run(async (e) => {
    e.preventDefault();
    const r = await POST('/playlists', { ...formValues(form), copy_from: init.copy_from });
    closeModal();
    location.hash = `#/playlists/${r.id}`;
  }));
  openModal({ title: init.copy_from ? '재생목록 복제' : '재생목록 만들기', body: form, foot: [h('button', { class: 'btn', onclick: closeModal }, '취소'), h('button', { class: 'btn primary', onclick: () => form.requestSubmit() }, '만들기')] });
}

const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
function scheduleText(it) {
  const parts = [];
  if (it.start_date || it.end_date) parts.push(`${it.start_date || '~'} ~ ${it.end_date || ''}`);
  if (it.start_time && it.end_time) parts.push(`${it.start_time}-${it.end_time}`);
  if (it.weekdays) parts.push(it.weekdays.split(',').map((d) => WEEK[d]).join(''));
  return parts.join(' · ');
}

async function renderPlaylistEditor(id) {
  const p = await GET(`/playlists/${id}`);
  const defaultSec = 5; // 사진 기본 노출 시간(항목별로 바꿀 수 있음)

  const header = h('form', { class: 'card form', onsubmit: (e) => e.preventDefault() },
    h('div', { class: 'row3' },
      field('재생목록 이름', input('name', p.name, { onchange: run((e) => PUT(`/playlists/${id}`, { name: e.target.value }).then(() => toast('저장됨'))) })),
      field('설명', input('description', p.description, { onchange: run((e) => PUT(`/playlists/${id}`, { description: e.target.value }).then(() => toast('저장됨'))) })),
      field('전환 효과', select('transition', [['slide', '옆으로 밀기'], ['fade', '페이드'], ['none', '없음']], p.transition, { onchange: run((e) => PUT(`/playlists/${id}`, { transition: e.target.value }).then(() => toast('저장됨'))) }))),
    h('p', { class: 'help' }, p.kiosks.length ? `사용 키오스크: ${p.kiosks.map((k) => k.name).join(', ')}` : '아직 이 재생목록을 쓰는 키오스크가 없습니다. 키오스크 메뉴에서 연결하세요.'));

  const list = h('div', { class: 'pl-items' });
  p.items.forEach((it, i) => list.append(itemRow(it, i)));
  enableDrag(list, async (ids) => {
    await PUT(`/playlists/${id}/order`, { ids });
    toast('순서를 저장했습니다.');
    renderPlaylistEditor(id);
  });

  fill(view, 
    // 제목·설명 없이: 왼쪽 [← 목록], 오른쪽 주 버튼들
    h('div', { class: 'page-head' },
      h('a', { class: 'btn', href: '#/playlists' }, '← 목록'),
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn', onclick: () => bulkDuration(p) }, '사진 시간 일괄 설정'),
        h('button', { class: 'btn primary', onclick: () => mediaPicker(id) }, '+ 사진/동영상 추가'))),
    header,
    h('div', { class: 'card' },
      h('h2', {}, '재생 순서'),
      p.items.length ? list : h('div', { class: 'empty-state' }, '[사진/동영상 추가]로 콘텐츠를 넣으세요.'))
  );

  function itemRow(it, i) {
    const save = run(async (data) => {
      await PUT(`/playlist-items/${it.id}`, data);
      toast('저장됨');
      renderPlaylistEditor(id);
    });
    const sched = scheduleText(it);
    return h('div', { class: `pl-item ${it.enabled ? '' : 'disabled'}`, draggable: 'true', 'data-id': it.id },
      h('div', { class: 'handle', title: '드래그해서 순서 변경' }, '⋮⋮'),
      h('div', { class: 'num' }, i + 1),
      thumb(it),
      h('div', {},
        h('div', { class: 'title' }, it.title),
        h('div', { class: 'sub' },
          h('span', {}, it.type === 'video' ? `동영상 ${fmtDur(it.media_duration) || ''} · 끝나면 다음` : `사진 · ${it.duration ? `${it.duration}초` : `기본(${defaultSec}초)`}`),
          // 노출 기간은 항상 보이게: 정했으면 노란 표시, 안 정했으면 '기간 없음(항상)'
          sched ? h('span', { class: 'badge warn' }, `노출 기간: ${sched}`) : h('span', { class: 'badge' }, '노출 기간: 항상'),
          !it.enabled ? h('span', { class: 'badge' }, '숨김') : null)),
      h('div', { class: 'ctrl' },
        it.type === 'image'
          ? h('label', { class: 'check' }, h('input', { type: 'number', min: 1, max: 3600, value: it.duration ?? '', placeholder: `${defaultSec}`, onchange: (e) => save({ duration: e.target.value === '' ? null : Number(e.target.value) }) }), '초')
          : h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !it.muted, onchange: (e) => save({ muted: e.target.checked ? 0 : 1 }) }), '소리'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!it.enabled, onchange: (e) => save({ enabled: e.target.checked ? 1 : 0 }) }), '노출'),
        h('button', { class: 'btn small', onclick: () => scheduleForm(it, save) }, '기간 설정'),
        h('button', { class: 'btn small danger', onclick: run(async () => { await DEL(`/playlist-items/${it.id}`); renderPlaylistEditor(id); }) }, '빼기')));
  }
}

/** list 의 [data-id] 자식들을 드래그로 정렬하고, 놓으면 새 id 순서로 onReorder 를 호출한다. */
function enableDrag(list, onReorder) {
  let dragging = null;
  const clearMarks = () => list.querySelectorAll('.drop-before').forEach((x) => x.classList.remove('drop-before'));
  list.addEventListener('dragstart', (e) => {
    dragging = e.target.closest('[data-id]');
    if (!dragging) return;
    dragging.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  list.addEventListener('dragover', (e) => {
    e.preventDefault();
    const over = e.target.closest('[data-id]');
    clearMarks();
    if (over && over !== dragging) over.classList.add('drop-before');
  });
  list.addEventListener('drop', run(async (e) => {
    e.preventDefault();
    const over = e.target.closest('[data-id]');
    clearMarks();
    if (!dragging || !over || over === dragging) return;
    list.insertBefore(dragging, over);
    await onReorder([...list.children].map((x) => Number(x.dataset.id)));
  }));
  list.addEventListener('dragend', () => dragging?.classList.remove('dragging'));
}

function scheduleForm(it, save) {
  const days = new Set((it.weekdays || '').split(',').filter(Boolean));
  const form = h('form', { class: 'form' },
    h('p', { class: 'help' }, '비워 두면 항상 노출됩니다. 기간이 지나면 자동으로 빠집니다.'),
    h('div', { class: 'row2' }, field('시작일', input('start_date', it.start_date, { type: 'date' })), field('종료일', input('end_date', it.end_date, { type: 'date' }))),
    h('div', { class: 'row2' }, field('노출 시작 시각', input('start_time', it.start_time, { type: 'time' })), field('노출 종료 시각', input('end_time', it.end_time, { type: 'time' }))),
    field('요일', h('div', { class: 'weekday-picks' }, WEEK.map((w, d) => h('label', { class: 'check' }, h('input', { type: 'checkbox', 'data-day': d, checked: days.has(String(d)) }), w))), '선택 안 하면 매일'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = formValues(form);
    const picked = [...form.querySelectorAll('[data-day]')].filter((c) => c.checked).map((c) => c.dataset.day);
    if ((v.start_time && !v.end_time) || (!v.start_time && v.end_time)) return toast('시작/종료 시각을 둘 다 입력하세요.', true);
    closeModal();
    save({ start_date: v.start_date, end_date: v.end_date, start_time: v.start_time, end_time: v.end_time, weekdays: picked.length && picked.length < 7 ? picked.join(',') : '' });
  });
  openModal({ title: `노출 기간 설정 · ${it.title}`, body: form, foot: [
    h('button', { class: 'btn', onclick: () => { closeModal(); save({ start_date: '', end_date: '', start_time: '', end_time: '', weekdays: '' }); } }, '기간 해제'),
    h('button', { class: 'btn primary', onclick: () => form.requestSubmit() }, '저장')] });
}

function bulkDuration(p) {
  const form = h('form', { class: 'form' },
    field('모든 사진의 노출 시간(초)', input('sec', 8, { type: 'number', min: 1, max: 3600, required: true })),
    h('p', { class: 'help' }, '비워진 항목은 키오스크 기본값을 따릅니다. 여기서 지정하면 이 재생목록의 모든 사진에 같은 시간이 적용됩니다.'));
  form.addEventListener('submit', run(async (e) => {
    e.preventDefault();
    const sec = formValues(form).sec;
    await Promise.all(p.items.filter((i) => i.type === 'image').map((i) => PUT(`/playlist-items/${i.id}`, { duration: sec })));
    closeModal();
    toast('적용했습니다.');
    renderPlaylistEditor(p.id);
  }));
  openModal({ title: '사진 시간 일괄 설정', body: form, foot: [h('button', { class: 'btn primary', onclick: () => form.requestSubmit() }, '적용')] });
}

async function mediaPicker(playlistId) {
  const chosen = new Set();
  const grid = h('div', { class: 'media-grid' });
  const draw = async () => {
    const media = await GET('/media');
    fill(grid, ...media.map((m) => {
      const card = h('div', { class: `media-card selectable ${chosen.has(m.id) ? 'selected' : ''}` }, thumb(m), h('div', { class: 'info' }, h('b', {}, m.title), h('span', { class: 'muted' }, fmtSize(m.size))));
      card.onclick = () => {
        chosen.has(m.id) ? chosen.delete(m.id) : chosen.add(m.id);
        card.classList.toggle('selected');
        addBtn.textContent = `선택한 ${chosen.size}개 추가`;
      };
      return card;
    }));
    if (!media.length) grid.append(h('div', { class: 'empty-state' }, '라이브러리가 비어 있습니다. 위에서 파일을 올려주세요.'));
  };
  const addBtn = h('button', { class: 'btn primary', onclick: run(async () => {
    if (!chosen.size) return toast('추가할 항목을 선택하세요.', true);
    // 선택 순서대로 추가된다.
    await POST(`/playlists/${playlistId}/items`, { media_ids: [...chosen] });
    closeModal();
    renderPlaylistEditor(playlistId);
  }) }, '선택한 0개 추가');
  openModal({
    title: '사진/동영상 추가',
    wide: true,
    body: h('div', {}, uploader(async (ids) => { ids.forEach((i) => chosen.add(i)); await draw(); addBtn.textContent = `선택한 ${chosen.size}개 추가`; }), grid),
    foot: [h('button', { class: 'btn', onclick: closeModal }, '취소'), addBtn],
  });
  await draw();
}

// ---------- 미디어 ----------
function readMeta(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const done = (m) => { URL.revokeObjectURL(url); resolve(m); };
    if (file.type.startsWith('video/')) {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => done({ duration: v.duration, width: v.videoWidth, height: v.videoHeight });
      v.onerror = () => done({});
      v.src = url;
    } else {
      const img = new Image();
      img.onload = () => done({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => done({});
      img.src = url;
    }
    setTimeout(() => done({}), 8000);
  });
}

/** 업로드 공통 처리: 파일 선택 창(fileInput), 진행 막대(prog), 끌어다 놓기 대상 지정(dropTarget) */
function makeUploader(onDone) {
  const bar = h('div');
  const prog = h('div', { class: 'progress', hidden: true }, bar);
  const fileInput = h('input', { type: 'file', multiple: true, accept: 'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm', hidden: true });
  const send = async (files) => {
    files = [...files];
    if (!files.length) return;
    const meta = await Promise.all(files.map(readMeta));
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f));
    fd.append('meta', JSON.stringify(meta));
    prog.hidden = false;
    const res = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/media');
      xhr.upload.onprogress = (e) => (bar.style.width = `${(e.loaded / e.total) * 100}%`);
      xhr.onload = () => {
        const body = JSON.parse(xhr.responseText || '{}');
        xhr.status < 400 ? resolve(body) : reject(new Error(body.error || '업로드 실패'));
      };
      xhr.onerror = () => reject(new Error('업로드 중 네트워크 오류'));
      xhr.send(fd);
    }).finally(() => { prog.hidden = true; bar.style.width = 0; });
    toast(`${res.ids.length}개 업로드 완료`);
    await onDone(res.ids);
  };
  fileInput.onchange = run(async () => { await send(fileInput.files); fileInput.value = ''; });
  const dropTarget = (el) => {
    const isFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    el.addEventListener('dragover', (e) => { if (!isFiles(e)) return; e.preventDefault(); el.classList.add('over'); });
    el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('over'); });
    el.addEventListener('drop', run(async (e) => { if (!isFiles(e)) return; e.preventDefault(); el.classList.remove('over'); await send(e.dataTransfer.files); }));
    return el;
  };
  return { fileInput, prog, dropTarget };
}

/** 미디어 고르기 창 등에서 쓰는 끌어다 놓기 상자 */
function uploader(onDone) {
  const u = makeUploader(onDone);
  return u.dropTarget(h('div', { class: 'dropzone' },
    h('div', {}, '사진(JPG/PNG/WEBP/GIF) 또는 동영상(MP4/WEBM)을 여기로 끌어다 놓거나 '),
    h('button', { type: 'button', class: 'btn small', style: 'margin-top:8px', onclick: () => u.fileInput.click() }, '파일 선택'),
    h('p', { class: 'help', style: 'margin-top:8px' }, '권장: 키오스크 화면 비율(세로 9:16), 동영상은 H.264 MP4'),
    u.fileInput, u.prog));
}

async function renderMedia(filter = 'all') {
  const media = await GET('/media');
  const shown = media.filter((m) => filter === 'all' || m.type === filter);
  const count = (t) => media.filter((m) => t === 'all' || m.type === t).length;
  const u = makeUploader(() => renderMedia(filter));
  fill(view,
    // 다른 메뉴처럼: 왼쪽 필터, 오른쪽 주 버튼
    h('div', { class: 'page-head' },
      h('div', { class: 'toolbar' },
        [['all', '전체'], ['image', '사진'], ['video', '동영상']].map(([v, l]) => h('button', { class: `btn small ${filter === v ? 'primary' : ''}`, onclick: () => renderMedia(v) }, `${l} ${count(v)}`))),
      h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', onclick: () => u.fileInput.click() }, '+ 사진/동영상 올리기'), u.fileInput)),
    u.dropTarget(h('div', { class: 'card media-panel' },
      h('p', { class: 'help', style: 'margin:0 0 12px' }, '파일을 이 상자에 끌어다 놓아도 올라갑니다. 권장: 키오스크 화면 비율(세로 9:16), 동영상은 H.264 MP4.'),
      u.prog,
      shown.length
        ? h('div', { class: 'media-grid' }, shown.map((m) =>
            h('div', { class: 'media-card' }, thumb(m),
              h('div', { class: 'info' },
                h('b', { title: m.original_name }, m.title),
                h('span', { class: 'muted' }, [m.width && `${m.width}×${m.height}`, fmtSize(m.size)].filter(Boolean).join(' · '))),
              h('div', { class: 'actions' },
                // 올릴 때의 원래 파일 이름으로 내려받는다.
                h('a', { class: 'btn small', href: mediaUrl(m.filename), download: m.original_name || m.filename }, '다운'),
                h('button', { class: 'btn small', onclick: run(async () => {
                  const form = h('form', { class: 'form' }, field('제목', input('title', m.title, { required: true })));
                  form.onsubmit = run(async (e) => { e.preventDefault(); await PUT(`/media/${m.id}`, formValues(form)); closeModal(); renderMedia(filter); });
                  openModal({ title: '이름 변경', body: form, foot: [h('button', { class: 'btn primary', onclick: () => form.requestSubmit() }, '저장')] });
                }) }, '이름'),
                h('button', { class: 'btn small danger', onclick: run(async () => {
                  if (!(await confirmBox(`'${m.title}'을(를) 삭제할까요?${m.usage ? `\n${m.usage}개 재생목록에서도 함께 빠집니다.` : ''}`))) return;
                  await DEL(`/media/${m.id}`);
                  renderMedia(filter);
                }) }, '삭제')))))
        : h('div', { class: 'empty-state' }, media.length ? '이 종류의 미디어가 없습니다.' : '아직 올린 미디어가 없습니다. 오른쪽 위 [+ 사진/동영상 올리기]로 추가하세요.')))
  );
}

// ---------- 시설 관리 (건물 · 층 · 시설) ----------
async function renderBuildings(selectedId) {
  const buildings = await GET('/buildings');
  const sel = buildings.find((b) => String(b.id) === String(selectedId)) || buildings[0];
  const tree = sel ? await GET(`/buildings/${sel.id}/tree`) : null;
  const reload = () => renderBuildings(sel?.id);

  fill(view, 
    menuHead(
      h('button', { class: 'btn', onclick: run(() => categoryManager(reload)) }, '분류 관리'),
      h('button', { class: 'btn primary', onclick: () => buildingForm() }, '+ 건물(동) 추가')),
    buildings.length
      ? h('div', { class: 'bld-layout' },
          h('div', { class: 'bld-list' }, buildings.map((b) =>
            h('button', { class: `bld-item ${b.id === sel.id ? 'active' : ''}`, onclick: () => (location.hash = `#/buildings/${b.id}`) },
              h('span', {}, h('b', {}, b.name), h('small', {}, `${b.floor_count}개 층 · 시설 ${b.facility_count} · 키오스크 ${b.kiosk_count}`))))),
          h('div', {},
            h('div', { class: 'card' },
              h('div', { class: 'page-head', style: 'margin:0' },
                h('div', {}, h('h2', { style: 'margin:0' }, tree.name, tree.code ? h('span', { class: 'muted' }, ` (${tree.code})`) : null), h('p', { class: 'muted' }, [tree.address, tree.description].filter(Boolean).join(' · '))),
                h('div', { class: 'toolbar' },
                  h('button', { class: 'btn small', onclick: () => buildingForm(tree) }, '동 정보 수정'),
                  h('button', { class: 'btn small primary', onclick: () => floorForm(tree.id, {}, reload) }, '+ 층 추가'),
                  h('button', { class: 'btn small danger', onclick: run(async () => {
                    if (!(await confirmBox(`'${tree.name}'과(와) 모든 층·시설을 삭제할까요?`))) return;
                    await DEL(`/buildings/${tree.id}`);
                    location.hash = '#/buildings';
                    renderBuildings();
                  }) }, '삭제')))),
            h('div', { style: 'margin-top:16px' },
              tree.floors.length ? tree.floors.map((f) => floorCard(f, tree, reload)) : h('div', { class: 'card empty-state' }, '[층 추가]로 B1, 1F, 2F ... 층을 만드세요.'))))
      : h('div', { class: 'card empty-state' }, '건물(동)을 먼저 추가하세요.')
  );
}

function floorCard(f, building, reload) {
  const mapInput = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: run(async (e) => {
    const fd = new FormData();
    fd.append('file', e.target.files[0]);
    await api('POST', `/floors/${f.id}/map`, fd);
    toast('도면을 올렸습니다. 시설 편집에서 위치 핀을 찍을 수 있습니다.');
    reload();
  }) });
  return h('div', { class: 'floor-card' },
    h('header', {},
      h('h3', {}, f.name), h('span', { class: 'badge' }, `레벨 ${f.level}`), f.description ? h('span', { class: 'muted' }, f.description) : null,
      h('span', { class: 'spacer' }),
      mapInput,
      h('button', { class: 'btn small', onclick: () => mapInput.click() }, f.map_image ? '도면 교체' : '도면 올리기'),
      f.map_image ? h('button', { class: 'btn small', onclick: run(async () => { await DEL(`/floors/${f.id}/map`); reload(); }) }, '도면 삭제') : null,
      h('button', { class: 'btn small', onclick: () => floorForm(building.id, f, reload) }, '층 수정'),
      h('button', { class: 'btn small primary', onclick: run(() => facilityForm(f, {}, reload)) }, '+ 시설'),
      h('button', { class: 'btn small', onclick: run(() => bulkFacilities(f, reload)) }, '일괄 입력'),
      h('button', { class: 'btn small danger', onclick: run(async () => {
        if (!(await confirmBox(`${f.name}과(와) 시설 ${f.facilities.length}개를 삭제할까요?`))) return;
        await DEL(`/floors/${f.id}`);
        reload();
      }) }, '삭제')),
    f.facilities.length
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'fac-table fixed-table' },
          colgroup('26%', '13%', '10%', null, null, '7%', '150px'),
          h('tbody', {}, f.facilities.map((x) =>
            h('tr', {},
              h('td', {}, h('b', {}, x.name), x.name_en ? h('div', { class: 'muted', style: 'font-size:14px' }, x.name_en) : null, x.keywords ? h('div', { class: 'muted', style: 'font-size:14px' }, `키워드: ${x.keywords}`) : null),
              h('td', {}, x.category ? h('span', { class: 'badge' }, x.category) : h('span', { class: 'muted' }, '분류 없음')),
              h('td', { class: 'muted' }, x.room_no ? `${x.room_no}호` : ''),
              h('td', { class: 'muted', style: 'font-size:14px' }, [summarizeRule(normalizeRule(x.hours_rule)), x.hours].filter(Boolean).join(' · ')),
              h('td', { class: 'muted' }, x.phone || ''),
              h('td', {}, x.pos_x != null ? h('span', { class: 'badge pin', title: '도면에 위치가 지정됨' }, '핀') : ''),
              h('td', { style: 'text-align:right;white-space:nowrap' },
                h('button', { class: 'btn small', onclick: run(() => facilityForm(f, x, reload)) }, '편집'), ' ',
                h('button', { class: 'btn small danger', onclick: run(async () => { await DEL(`/facilities/${x.id}`); reload(); }) }, '삭제')))))))
      : h('div', { class: 'muted', style: 'padding:14px' }, '등록된 시설이 없습니다.'));
}

/** 아이콘 버튼. 누르면 아래에 아이콘 고르기 판이 열리고, 고르면 onPick(이름) */
function iconButton(value, onPick) {
  const btn = h('button', { type: 'button', class: 'icon-pick', title: '아이콘 고르기' });
  const show = (name) => { btn.innerHTML = iconSvg(name) || '<span class="muted">없음</span>'; };
  show(value);
  btn.addEventListener('click', () => {
    const host = btn.closest('.cat-row, form');
    const open = host.nextElementSibling?.classList.contains('icon-grid');
    document.querySelectorAll('.icon-grid').forEach((g) => g.remove());
    if (open) return;
    const pick = async (name) => {
      grid.remove();
      await onPick(name);
      value = name;
      show(name);
    };
    const grid = h('div', { class: 'icon-grid' },
      h('button', { type: 'button', class: `icon-cell ${!value ? 'on' : ''}`, onclick: run(() => pick('')) }, h('span', { class: 'muted' }, '없음')),
      Object.entries(ICONS).map(([name, [label]]) => {
        const cell = h('button', { type: 'button', class: `icon-cell ${name === value ? 'on' : ''}`, title: label, onclick: run(() => pick(name)) });
        cell.innerHTML = `${iconSvg(name)}<small>${label}</small>`;
        return cell;
      }));
    host.after(grid);
  });
  return btn;
}

/** 키오스크 층별 안내의 분류 버튼 목록(아이콘·이름·순서)을 관리한다. */
async function categoryManager(reload) {
  const categories = await GET('/categories');
  const list = h('div', { class: 'cat-list' }, categories.map((c) =>
    h('div', { class: 'cat-row', draggable: 'true', 'data-id': c.id },
      h('span', { class: 'handle', title: '드래그해서 순서 변경' }, '⋮⋮'),
      iconButton(c.icon, async (icon) => { await PUT(`/categories/${c.id}`, { icon }); toast('저장됨'); reload(); }),
      h('input', { value: c.name, title: '한국어 이름', onchange: run(async (e) => { await PUT(`/categories/${c.id}`, { name: e.target.value }); toast('저장됨'); reload(); }) }),
      h('input', { value: c.name_en || '', placeholder: 'English', title: '영문 이름(키오스크 English 화면)', onchange: run(async (e) => { await PUT(`/categories/${c.id}`, { name_en: e.target.value }); toast('저장됨'); reload(); }) }),
      h('span', { class: 'muted', style: 'white-space:nowrap' }, `시설 ${c.facility_count}개`),
      h('button', { type: 'button', class: 'btn small danger', onclick: run(async () => {
        if (c.facility_count && !(await confirmBox(`'${c.name}' 분류를 삭제할까요?\n이 분류의 시설 ${c.facility_count}개는 '분류 없음'이 됩니다.`))) return categoryManager(reload);
        await DEL(`/categories/${c.id}`);
        reload();
        categoryManager(reload);
      }) }, '삭제'))));
  enableDrag(list, async (ids) => {
    await PUT('/categories/order', { ids });
    toast('순서를 저장했습니다.');
  });
  let newIcon = '';
  const add = h('form', { class: 'toolbar', style: 'margin-top:12px' },
    iconButton('', (icon) => { newIcon = icon; }),
    h('input', { name: 'name', placeholder: '새 분류 이름 (예: 열람실)', required: true, style: 'flex:1' }),
    h('input', { name: 'name_en', placeholder: 'English (예: Reading room)', style: 'flex:1' }),
    h('button', { class: 'btn primary' }, '추가'));
  add.addEventListener('submit', run(async (e) => {
    e.preventDefault();
    await POST('/categories', { name: add.elements.name.value, name_en: add.elements.name_en.value, icon: newIcon });
    reload();
    categoryManager(reload);
  }));
  openModal({
    title: '분류 관리',
    body: h('div', {},
      h('p', { class: 'help', style: 'margin-bottom:12px' }, '키오스크 검색창 아래의 분류 버튼입니다. 왼쪽 아이콘을 누르면 아이콘을 바꿀 수 있습니다. 이 순서대로 나오고, 시설이 하나도 없는 분류는 키오스크에서 숨겨집니다. 이름을 고치면 바로 저장됩니다. 오른쪽 칸은 키오스크 English 화면에 쓰는 영문 이름입니다.'),
      list, add),
  });
}

function buildingForm(b = {}) {
  const form = h('form', { class: 'form' },
    h('div', { class: 'row3' }, field('동 이름', input('name', b.name, { required: true, placeholder: '예: 본관, A동, 세종관' })), field('영문 이름', input('name_en', b.name_en, { placeholder: '예: Main Hall' })), field('동 코드', input('code', b.code, { placeholder: '예: A' }))),
    field('주소/위치', input('address', b.address)),
    field('설명', textarea('description', b.description, { rows: 2 })),
    field('표시 순서', input('sort_order', b.sort_order ?? 0, { type: 'number' })));
  form.addEventListener('submit', run(async (e) => {
    e.preventDefault();
    if (b.id) await PUT(`/buildings/${b.id}`, formValues(form));
    else {
      const r = await POST('/buildings', formValues(form));
      location.hash = `#/buildings/${r.id}`;
    }
    closeModal();
    renderBuildings(b.id);
  }));
  openModal({ title: b.id ? '동 정보 수정' : '건물(동) 추가', body: form, foot: [h('button', { class: 'btn', onclick: closeModal }, '취소'), h('button', { class: 'btn primary', onclick: () => form.requestSubmit() }, '저장')] });
}

function floorForm(buildingId, f, reload) {
  const form = h('form', { class: 'form' },
    h('div', { class: 'row2' },
      field('층 이름', input('name', f.name, { required: true, placeholder: '예: 1F, B1, 옥상' })),
      field('층 레벨(숫자)', input('level', f.level ?? 1, { type: 'number', required: true }), '지하 1층 = -1, 층 순서에 사용')),
    h('div', { class: 'row2' },
      field('층 설명', input('description', f.description, { placeholder: '예: 로비 · 카페 · 안내데스크' })),
      field('영문 층 설명', input('description_en', f.description_en, { placeholder: '예: Lobby · Cafe · Info desk' }))));
  form.addEventListener('submit', run(async (e) => {
    e.preventDefault();
    if (f.id) await PUT(`/floors/${f.id}`, formValues(form));
    else await POST(`/buildings/${buildingId}/floors`, formValues(form));
    closeModal();
    reload();
  }));
  openModal({ title: f.id ? '층 수정' : '층 추가', body: form, foot: [h('button', { class: 'btn', onclick: closeModal }, '취소'), h('button', { class: 'btn primary', onclick: () => form.requestSubmit() }, '저장')] });
}

/**
 * 요일별 운영시간 입력: 평일 / 토요일 / 일요일·공휴일 각각 [운영 · 휴무 · 24시간] + 시작·종료 시각.
 * 키오스크는 이 값으로 '운영 중 / 곧 종료 / 운영 종료'를 자동 표시한다.
 */
function hoursEditor(rule) {
  const LABEL = { wd: '평일(월~금)', sat: '토요일', sun: '일요일·공휴일' };
  const base = rule || { wd: { open: '09:00', close: '18:00' }, sat: 'closed', sun: 'closed' };
  const mode = select('hours_mode', [['none', '표시 안 함'], ['set', '요일별 지정']], rule ? 'set' : 'none');
  const rows = DAY_KEYS.map((k) => {
    const v = base[k];
    const kind = select(`${k}_kind`, [['time', '운영'], ['closed', '휴무'], ['24h', '24시간']], typeof v === 'object' ? 'time' : v);
    const open = input(`${k}_open`, typeof v === 'object' ? v.open : '09:00', { type: 'time' });
    const close = input(`${k}_close`, typeof v === 'object' ? v.close : '18:00', { type: 'time' });
    const sync = () => { open.disabled = close.disabled = kind.value !== 'time'; };
    kind.addEventListener('change', sync);
    sync();
    return { k, kind, open, close, el: h('div', { class: 'hours-row' }, h('span', {}, LABEL[k]), kind, open, h('span', { class: 'muted' }, '~'), close) };
  });
  const box = h('div', { class: 'hours-rows' }, rows.map((r) => r.el));
  const syncMode = () => { box.hidden = mode.value !== 'set'; };
  mode.addEventListener('change', syncMode);
  syncMode();
  return {
    el: h('div', { class: 'field' }, h('span', {}, '운영시간', h('small', {}, ' · 키오스크에 운영 중/종료가 자동 표시됩니다')), mode, box),
    value: () => (mode.value !== 'set' ? null
      : normalizeRule(Object.fromEntries(rows.map((r) => [r.k, r.kind.value === 'time' ? { open: r.open.value, close: r.close.value } : r.kind.value])))),
  };
}

async function facilityForm(floor, x, reload) {
  const categories = await GET('/categories');
  const pos = { x: x.pos_x ?? null, y: x.pos_y ?? null };
  const hours = hoursEditor(normalizeRule(x.hours_rule));
  const mapBox = h('div');
  const drawMap = () => {
    if (!floor.map_image) {
      fill(mapBox, h('p', { class: 'help' }, '층 도면을 올리면 시설 위치 핀을 지정할 수 있습니다.'));
      return;
    }
    const others = floor.facilities.filter((o) => o.id !== x.id && o.pos_x != null).map((o) => h('div', { class: 'mpin other', style: `left:${o.pos_x}%;top:${o.pos_y}%` }, o.name));
    const ed = h('div', { class: 'map-editor' }, h('img', { src: mediaUrl(floor.map_image), draggable: 'false' }), others,
      pos.x != null ? h('div', { class: 'mpin', style: `left:${pos.x}%;top:${pos.y}%` }, x.name || '이 시설') : null);
    ed.addEventListener('click', (e) => {
      const r = ed.getBoundingClientRect();
      pos.x = +(((e.clientX - r.left) / r.width) * 100).toFixed(2);
      pos.y = +(((e.clientY - r.top) / r.height) * 100).toFixed(2);
      drawMap();
    });
    fill(mapBox, h('p', { class: 'help', style: 'margin-bottom:6px' }, '도면을 클릭해 시설 위치를 지정하세요.'), ed,
      pos.x != null ? h('button', { type: 'button', class: 'btn small', style: 'margin-top:6px', onclick: () => { pos.x = pos.y = null; drawMap(); } }, '핀 지우기') : null);
  };
  drawMap();
  const form = h('form', { class: 'form' },
    h('div', { class: 'row3' },
      field('시설 이름', input('name', x.name, { required: true, placeholder: '예: 학생지원팀' })),
      field('영문 이름', input('name_en', x.name_en, { placeholder: '예: Student Support' }), 'English 화면용'),
      field('분류', select('category_id', [['', '분류 없음'], ...categories.map((c) => [c.id, c.name])], x.category_id), '[분류 관리]에서 변경')),
    h('div', { class: 'row2' },
      field('호실', input('room_no', x.room_no, { placeholder: '예: 101' })),
      field('연락처', input('phone', x.phone))),
    hours.el,
    field('운영시간 메모', input('hours', x.hours, { placeholder: '예: 점심시간 12:00-13:00, 공휴일 휴무' }), '요일별 시간과 함께 보여줄 안내'),
    field('검색 키워드', input('keywords', x.keywords, { placeholder: '예: 행정실, 장학금, 증명서' }), '쉼표로 구분'),
    h('div', { class: 'row2' },
      field('설명', textarea('description', x.description, { rows: 2 })),
      field('영문 설명', textarea('description_en', x.description_en, { rows: 2 }))),
    mapBox);
  form.addEventListener('submit', run(async (e) => {
    e.preventDefault();
    const data = { ...formValues(form), hours_rule: hours.value(), pos_x: pos.x, pos_y: pos.y };
    if (form.elements.hours_mode.value === 'set' && !data.hours_rule) return toast('운영시간의 시작·종료 시각을 확인하세요(같은 시각은 안 됩니다).', true);
    delete data.hours_mode;
    for (const k of DAY_KEYS) for (const s of ['kind', 'open', 'close']) delete data[`${k}_${s}`];
    if (x.id) await PUT(`/facilities/${x.id}`, data);
    else await POST(`/floors/${floor.id}/facilities`, data);
    closeModal();
    reload();
  }));
  openModal({ title: `${floor.name} · ${x.id ? '시설 편집' : '시설 추가'}`, wide: !!floor.map_image, body: form, foot: [h('button', { class: 'btn', onclick: closeModal }, '취소'), h('button', { class: 'btn primary', onclick: () => form.requestSubmit() }, '저장')] });
}

async function bulkFacilities(floor, reload) {
  const categories = await GET('/categories');
  const byName = new Map(categories.map((c) => [c.name, c.id]));
  const ta = textarea('lines', '', { rows: 10, placeholder: '한 줄에 하나씩: 이름, 분류, 호실, 운영시간, 영문 이름\n예)\n학생지원팀, 사무실, 101, 평일 09:00-18:00 / 토 휴무 / 일 휴무, Student Support\n카페 세종, 카페, , 08:00-20:00, Cafe Sejong\n남자화장실, 화장실' });
  const form = h('form', { class: 'form' }, field(`${floor.name}에 여러 시설 한번에 등록`, ta), h('p', { class: 'help' }, `엑셀에서 열 순서(이름, 분류, 호실, 운영시간, 영문 이름)대로 복사해 붙여넣어도 됩니다(탭 구분 지원). 쉼표로 구분할 때는 운영시간 안에서 요일을 / 로 나누세요. 운영시간은 “평일 09:00-18:00 / 토 10:00-15:00 / 일 휴무”처럼 적으면 요일별 시간으로 자동 변환됩니다. 분류는 다음 중 하나로 적으세요: ${categories.map((c) => c.name).join(', ')}`));
  form.addEventListener('submit', run(async (e) => {
    e.preventDefault();
    // 엑셀에서 붙여넣으면 탭으로, 직접 쓰면 쉼표로 나눈다.
    const rows = ta.value.split('\n').map((l) => l.split(l.includes('\t') ? '\t' : ',').map((s) => s.trim())).filter((r) => r[0]);
    const unknown = new Set();
    for (const [name, category, room_no, hours, name_en] of rows) {
      if (category && !byName.has(category)) unknown.add(category);
      await POST(`/floors/${floor.id}/facilities`, { name, category_id: byName.get(category) ?? null, room_no, hours, name_en });
    }
    toast(unknown.size ? `${rows.length}개 등록. 목록에 없는 분류(${[...unknown].join(', ')})는 '분류 없음'으로 넣었습니다.` : `${rows.length}개 등록했습니다.`, unknown.size > 0);
    closeModal();
    reload();
  }));
  openModal({ title: '시설 일괄 입력', body: form, foot: [h('button', { class: 'btn primary', onclick: () => form.requestSubmit() }, '등록')] });
}

// ---------- 공지(하단 티커) ----------
async function renderNotices(scope = '') {
  const [notices, buildings, kiosks] = await Promise.all([GET('/notices'), GET('/buildings'), GET('/kiosks')]);
  const now = new Date();
  const nowStr = new Date(now - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const live = (n) => n.active && (!n.start_at || n.start_at <= nowStr) && (!n.end_at || n.end_at > nowStr);
  const idsOf = (n) => String(n.target_ids || '').split(',').filter(Boolean).map(Number);
  const targetText = (n) => {
    if (n.target_type === 'all') return '전체 키오스크';
    const pool = n.target_type === 'building' ? buildings : kiosks;
    return pool.filter((x) => idsOf(n).includes(x.id)).map((x) => x.name).join(', ') || '(대상 없음)';
  };
  // 키오스크가 실제로 받는 공지: 전체 + 자기 건물 + 자기 자신 (키오스크 화면과 같은 규칙)
  const reachesKiosk = (n, k) => n.target_type === 'all'
    || (n.target_type === 'building' && idsOf(n).includes(k.building_id))
    || (n.target_type === 'kiosk' && idsOf(n).includes(k.id));
  // 건물: 그 건물에 설치된 키오스크 중 한 곳이라도 받는 공지
  const reachesBuilding = (n, b) => n.target_type === 'all'
    || (n.target_type === 'building' && idsOf(n).includes(b.id))
    || (n.target_type === 'kiosk' && kiosks.some((k) => k.building_id === b.id && idsOf(n).includes(k.id)));

  const [kind, sid] = scope.split('-');
  const selB = kind === 'b' ? buildings.find((b) => b.id === Number(sid)) : null;
  const selK = kind === 'k' ? kiosks.find((k) => k.id === Number(sid)) : null;
  const shown = selK ? notices.filter((n) => reachesKiosk(n, selK)) : selB ? notices.filter((n) => reachesBuilding(n, selB)) : notices;
  const preset = selK ? { target_type: 'kiosk', target_ids: String(selK.id) } : selB ? { target_type: 'building', target_ids: String(selB.id) } : {};

  // 송출 순서 번호: 지금 나가고 있는 공지만 1, 2, 3… (꺼짐·대기는 '–')
  let seq = 0;
  const order = new Map(shown.map((n) => [n.id, live(n) ? ++seq : null]));
  const liveCount = seq;

  const item = (key, label, sub, count) => h('button', { class: `bld-item ${scope === key ? 'active' : ''}`, onclick: () => (location.hash = `#/notices${key ? `/${key}` : ''}`) },
    h('div', { style: 'flex:1;min-width:0' }, h('b', {}, label), sub ? h('small', {}, sub) : null),
    h('span', { class: 'badge', title: '송출 중인 공지 수' }, String(count)));
  const liveFor = (fn) => notices.filter((n) => live(n) && fn(n)).length;

  // 키오스크 하단에 실제로 흐르는 글과 같은 모양(제목 — 내용)으로 보여준다. 전체·건물·키오스크 모두.
  const ticker = liveCount ? h('div', { class: 'ticker-preview' }, h('span', { class: 'badge ok' }, '출력 예'),
    h('span', {}, shown.filter(live).map((n) => (n.body ? `${n.title} — ${n.body}` : n.title)).join('  •  '))) : null;

  let noticeRows = null;
  const table = shown.length
    ? h('div', { class: 'table-wrap' }, h('table', { class: 'fixed-table', style: 'min-width:780px' },
        colgroup('34px', '52px', null, '130px', '150px', '100px', '170px'),
        h('thead', {}, h('tr', {}, ['', '순서', '제목', '대상', '기간', '상태', ''].map((t) => h('th', {}, t)))),
        noticeRows = h('tbody', {}, shown.map((n) =>
          h('tr', { draggable: 'true', 'data-id': n.id },
            h('td', { class: 'handle', title: '드래그해서 순서 변경' }, '⋮⋮'),
            h('td', {}, order.get(n.id) ? h('span', { class: 'order-no' }, order.get(n.id)) : h('span', { class: 'muted' }, '–')),
            h('td', {}, h('b', {}, n.title), n.body ? h('div', { class: 'muted', style: 'font-size:14px' }, n.body) : null),
            h('td', { class: 'muted' }, targetText(n)),
            h('td', { class: 'muted', style: 'font-size:14px' }, `${(n.start_at || '즉시').replace('T', ' ')} ~ ${(n.end_at || '해제 시까지').replace('T', ' ')}`),
            h('td', {}, live(n) ? h('span', { class: 'badge ok dot' }, '송출 중') : n.active ? h('span', { class: 'badge warn' }, '대기/만료') : h('span', { class: 'badge' }, '꺼짐')),
            h('td', { style: 'text-align:right;white-space:nowrap' },
              h('button', { class: 'btn small', onclick: run(async () => { await PUT(`/notices/${n.id}`, { active: n.active ? 0 : 1 }); route(); }) }, n.active ? '끄기' : '켜기'), ' ',
              h('button', { class: 'btn small', onclick: () => noticeForm(n, buildings, kiosks) }, '편집'), ' ',
              h('button', { class: 'btn small danger', onclick: run(async () => { await DEL(`/notices/${n.id}`); route(); }) }, '삭제')))))))
    : h('div', { class: 'empty-state' }, selK || selB ? '이곳으로 나가는 공지가 없습니다.' : '등록된 공지가 없습니다.');

  fill(view,
    menuHead(h('button', { class: 'btn primary', onclick: () => noticeForm(preset, buildings, kiosks) }, '+ 공지 등록')),
    h('div', { class: 'bld-layout notice-layout' },
      h('div', { class: 'bld-list' },
        item('', '전체 공지', `${notices.length}개 등록`, liveFor(() => true)),
        buildings.length ? h('div', { class: 'list-label' }, '건물(동)별') : null,
        buildings.map((b) => item(`b-${b.id}`, b.name, null, liveFor((n) => reachesBuilding(n, b)))),
        kiosks.length ? h('div', { class: 'list-label' }, '키오스크별') : null,
        kiosks.map((k) => item(`k-${k.id}`, k.name, k.building_name || null, liveFor((n) => reachesKiosk(n, k))))),
      h('div', { class: 'card', style: 'min-width:0' },
        ticker,
        table)));

  // 일부만 보이는 화면에서 끌어 옮겨도, 보이는 공지들이 원래 차지하던 자리 안에서만 순서를 바꾼다.
  if (noticeRows) enableDrag(noticeRows, async (ids) => {
    const all = notices.map((n) => n.id);
    const slots = all.map((id, i) => (ids.includes(id) ? i : -1)).filter((i) => i >= 0);
    slots.forEach((slot, i) => (all[slot] = ids[i]));
    await PUT('/notices/order', { ids: all });
    toast('순서를 저장했습니다');
    route();
  });
}

function noticeForm(n, buildings, kiosks) {
  const savedIds = String(n.target_ids || '').split(',').filter(Boolean);
  const targetBox = h('div');
  const typeSel = select('target_type', [['all', '전체 키오스크'], ['building', '특정 건물(동)'], ['kiosk', '특정 키오스크']], n.target_type || 'all');
  // 특정 건물/키오스크: 송출 대상과 같은 선택 상자로 한 곳을 고른다.
  const drawTargets = (ids) => {
    const type = typeSel.value;
    const pool = type === 'building' ? buildings : type === 'kiosk' ? kiosks : [];
    if (!pool.length) return fill(targetBox, type === 'all' ? null : h('p', { class: 'help' }, type === 'building' ? '등록된 건물이 없습니다.' : '등록된 키오스크가 없습니다.'));
    fill(targetBox, field(type === 'building' ? '송출할 건물(동)' : '송출할 키오스크',
      select('', pool.map((x) => [x.id, x.name]), ids[0] ?? pool[0].id, { 'data-target': '' })));
  };
  typeSel.addEventListener('change', () => drawTargets([]));
  drawTargets(savedIds);
  const form = h('form', { class: 'form' },
    field('제목', input('title', n.title, { required: true })),
    field('내용', textarea('body', n.body, { rows: 3 })),
    field('송출 대상', typeSel), targetBox,
    h('div', { class: 'row2' },
      field('시작', input('start_at', n.start_at, { type: 'datetime-local' }), '비우면 즉시'),
      field('종료', input('end_at', n.end_at, { type: 'datetime-local' }), '비우면 직접 해제할 때까지')));
  form.addEventListener('submit', run(async (e) => {
    e.preventDefault();
    const data = { ...formValues(form), target_ids: [...new Set([...form.querySelectorAll('[data-target]')].map((x) => x.value))] };
    if (data.target_type !== 'all' && !data.target_ids.length) return toast('송출 대상을 선택하세요.', true);
    if (n.id) await PUT(`/notices/${n.id}`, data);
    else await POST('/notices', data);
    closeModal();
    toast('저장했습니다. 키오스크에 즉시 반영됩니다.');
    route();
  }));
  openModal({ title: n.id ? '공지 편집' : '공지 등록', body: form, foot: [h('button', { class: 'btn', onclick: closeModal }, '취소'), h('button', { class: 'btn primary', onclick: () => form.requestSubmit() }, '저장')] });
}

// ---------- 로그인 ----------
function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
}
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await POST('/auth/login', { password: e.target.password.value });
    e.target.reset();
    start();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});
$('#logout').addEventListener('click', run(async () => { await POST('/auth/logout'); showLogin(); }));

async function start() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  await route();
}

try {
  await GET('/auth/me');
  start();
} catch {
  showLogin();
}
