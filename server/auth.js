import crypto from 'node:crypto';

const PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sessions = new Map(); // token -> expiresAt
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 10;
const loginFails = new Map(); // ip -> { count, resetAt }

if (!PASSWORD) {
  console.error('[auth] ADMIN_PASSWORD 가 없습니다. .env.example 을 .env 로 복사하고 비밀번호를 정한 뒤 다시 실행하세요.');
  process.exit(1);
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((p) => p.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])
  );
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// 외부에 공개된 주소에서 비밀번호를 무작위로 대입하지 못하도록 IP별 실패 횟수를 제한한다.
export function login(req, res) {
  const now = Date.now();
  let fail = loginFails.get(req.ip);
  if (fail && fail.resetAt < now) {
    loginFails.delete(req.ip);
    fail = null;
  }
  if (fail && fail.count >= LOGIN_MAX_FAILS) {
    return res.status(429).json({ error: '로그인 시도가 너무 많습니다. 15분 뒤 다시 시도하세요.' });
  }
  if (!safeEqual(req.body?.password ?? '', PASSWORD)) {
    loginFails.set(req.ip, { count: (fail?.count || 0) + 1, resetAt: fail?.resetAt || now + LOGIN_WINDOW_MS });
    return res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
  }
  loginFails.delete(req.ip);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, now + SESSION_TTL_MS);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${req.secure ? '; Secure' : ''}`);
  res.json({ ok: true });
}

export function logout(req, res) {
  sessions.delete(parseCookies(req.headers.cookie).sid);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
}

export function requireAdmin(req, res, next) {
  const token = parseCookies(req.headers.cookie).sid;
  const exp = token && sessions.get(token);
  if (!exp || exp < Date.now()) {
    if (token) sessions.delete(token);
    return res.status(401).json({ error: '로그인이 필요합니다.' });
  }
  next();
}
