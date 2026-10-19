// 키오스크 실시간 연결(SSE) 허브: 콘텐츠 변경/원격 명령을 즉시 푸시한다.
// 프록시·터널이 SSE 를 막는 환경을 위해 원격 명령은 잠시 보관했다가 키오스크의 주기 확인(poll)으로도 전달한다.
const clients = new Map(); // code -> Set<res>
const pending = new Map(); // code -> [{ id, type, data, at }]
const COMMAND_TTL_MS = 2 * 60 * 1000;
let lastCommandId = 0;

export function addClient(code, res) {
  if (!clients.has(code)) clients.set(code, new Set());
  clients.get(code).add(res);
  return () => {
    const set = clients.get(code);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) clients.delete(code);
  };
}

export function isConnected(code) {
  return clients.has(code);
}

export function send(code, event, data = {}) {
  const set = clients.get(code);
  if (!set) return 0;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) res.write(payload);
  return set.size;
}

export function broadcast(event, data = {}) {
  for (const code of clients.keys()) send(code, event, data);
}

/** 서버를 재시작해도 줄어들지 않도록 시각 기반으로 증가하는 명령 번호 */
export const commandClock = () => Math.max(Date.now(), lastCommandId);

export function sendCommand(code, type, data = {}) {
  const cmd = { id: (lastCommandId = Math.max(Date.now(), lastCommandId + 1)), type, data, at: Date.now() };
  const list = (pending.get(code) || []).filter((c) => Date.now() - c.at < COMMAND_TTL_MS);
  list.push(cmd);
  pending.set(code, list);
  return send(code, type, { ...data, id: cmd.id });
}

export function commandsSince(code, since) {
  const list = (pending.get(code) || []).filter((c) => Date.now() - c.at < COMMAND_TTL_MS);
  pending.set(code, list);
  return list.filter((c) => c.id > since).map(({ id, type, data }) => ({ id, type, ...data }));
}

let timer = null;
// 관리자 변경이 연달아 일어나도 키오스크에는 한 번만 알린다.
export function notifyConfigChanged() {
  clearTimeout(timer);
  timer = setTimeout(() => broadcast('config'), 400);
}

// 연결 유지 + 키오스크가 SSE 가 실제로 살아 있는지 판단할 수 있도록 주기적으로 신호를 보낸다.
setInterval(() => broadcast('ping'), 25000).unref();
