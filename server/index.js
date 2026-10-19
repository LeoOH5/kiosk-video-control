import express from 'express';
import path from 'node:path';
import { ROOT, UPLOAD_DIR } from './db.js';
import adminApi from './admin-api.js';
import kioskApi from './kiosk-api.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // 터널/프록시를 거쳐 http:// 로 들어오면 https:// 로 넘긴다(브라우저의 '안전하지 않음' 경고 방지).
    if (req.headers['x-forwarded-proto'] === 'http' && req.method === 'GET') return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
    next();
  });

  app.use('/api/k', kioskApi);
  app.use('/api', adminApi);

  // 업로드 파일명은 매번 새로 생성되므로 길게 캐시해도 안전하다(키오스크 재부팅 시 재다운로드 방지).
  app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true, index: false }));
  app.use('/admin', express.static(path.join(ROOT, 'public/admin')));
  app.use('/kiosk-assets', express.static(path.join(ROOT, 'public/kiosk')));
  app.use('/shared', express.static(path.join(ROOT, 'public/shared'))); // 키오스크·관리자 공용 모듈
  app.get('/k/:code', (req, res) => {
    // 현장 연결 문제를 확인할 수 있도록 키오스크 화면 접속을 기록한다.
    console.log(`[kiosk] ${new Date().toISOString()} ${req.params.code} ${req.ip} ${req.headers['user-agent'] || ''}`);
    res.sendFile(path.join(ROOT, 'public/kiosk/index.html'));
  });
  app.get('/', (req, res) => res.redirect('/admin/'));

  app.use((err, req, res, next) => {
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? '서버 오류가 발생했습니다.' : err.message });
  });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => {
    console.log(`키오스크 CMS 실행 중`);
    console.log(`  관리자:   http://localhost:${port}/admin/`);
    console.log(`  키오스크: http://localhost:${port}/k/<키오스크코드>`);
  });
}
