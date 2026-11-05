import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import authRoutes from './routes/auth.js';
import coupleRoutes from './routes/couple.js';
import paymentRoutes from './routes/payments.js';
import webhookRoutes from './routes/webhooks.js';
import chatRoutes from './routes/chat.js';
import vaultRoutes from './routes/vault.js';
import memoriesRoutes from './routes/memories.js';
import notesRoutes from './routes/notes.js';
import specialMomentsRoutes from './routes/specialMoments.js';
import notificationsRoutes from './routes/notifications.js';
import gamesRoutes from './routes/games.js';
import adminRoutes from './routes/admin.js';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadsDir = path.join(process.cwd(), 'uploads');
const adminUiDir = path.join(__dirname, 'admin-ui');

function ensureUploadDirs() {
  for (const sub of ['', 'vault', 'memories']) {
    const dir = sub ? path.join(uploadsDir, sub) : uploadsDir;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  const chatMediaDir = path.join(process.cwd(), 'data', 'chat');
  if (!fs.existsSync(chatMediaDir)) fs.mkdirSync(chatMediaDir, { recursive: true });
}

export function createApp() {
  ensureUploadDirs();
  const app = express();

  app.use(
    cors({
      origin: config.CORS_ORIGIN === '*' ? true : config.CORS_ORIGIN.split(','),
      credentials: true,
    }),
  );
  // PhonePe webhook must receive the raw body string for signature validation.
  app.use(
    '/api/v1/webhooks',
    express.text({ type: '*/*', limit: '256kb' }),
    webhookRoutes,
  );

  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'smitten-api' });
  });

  app.get('/.well-known/assetlinks.json', (_req, res) => {
    const fingerprint = config.ANDROID_APP_LINK_SHA256_CERT_FINGERPRINT?.trim();
    res.json(fingerprint ? [{
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'com.anonymous.smitten',
        sha256_cert_fingerprints: [fingerprint],
      },
    }] : []);
  });

  app.get('/.well-known/apple-app-site-association', (_req, res) => {
    const teamId = config.IOS_TEAM_ID?.trim();
    res.type('application/json').json({
      applinks: {
        apps: [],
        details: teamId ? [{ appID: `${teamId}.com.anonymous.smitten`, paths: ['/join/*'] }] : [],
      },
    });
  });

  app.get('/join/:code', (req, res) => {
    const code = String(req.params.code ?? '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    if (!code) {
      res.status(400).type('html').send('<h1>Invalid couple link</h1>');
      return;
    }
    const appLink = `smitten://join/${encodeURIComponent(code)}`;
    res.set('Cache-Control', 'no-store').type('html').send(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Join Smittenz</title></head>
<body style="font-family:system-ui;text-align:center;padding:48px 20px"><h1>Join your partner on Smittenz</h1><p>Your couple code is <strong>${code}</strong>.</p><a href="${appLink}" style="display:inline-block;padding:14px 22px;border-radius:12px;background:#BC142B;color:#fff;text-decoration:none;font-weight:700">Open Smittenz</a><p>Install Smittenz, then choose <strong>I have a key</strong> and enter this code.</p></body></html>`);
  });

  // Admin panel — server-rendered DB browser, gated behind ADMIN_PASSWORD (see config.ts).
  // adminRoutes is scoped strictly to /admin/api/* so its internal auth guard never
  // intercepts the static UI shell (/admin, /admin/styles.css, /admin/app.js, deep links).
  app.use('/admin/api', adminRoutes);
  app.use('/admin', express.static(adminUiDir));
  app.get('/admin', (_req, res) => {
    res.sendFile(path.join(adminUiDir, 'index.html'));
  });
  app.get(/^\/admin\/(?!api).*/, (_req, res) => {
    // Any other /admin/* path (e.g. a deep link or refresh) gets the SPA shell too.
    res.sendFile(path.join(adminUiDir, 'index.html'));
  });

  /** PhonePe redirects here after checkout — the app verifies final status by polling PhonePe. */
  app.get('/payment-complete', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="0;url=smitten:///payment-complete" />
  <title>Payment status — Smittenz</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #fdf2f0; color: #1a1a1a;
      display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; }
    .card { background: #fff; border-radius: 20px; padding: 32px; max-width: 360px; text-align: center;
      box-shadow: 0 8px 32px rgba(26,26,26,0.08); }
    h1 { font-size: 1.35rem; margin: 0 0 12px; }
    p { color: #6b7280; line-height: 1.5; margin: 0 0 22px; }
    a { display: inline-flex; min-height: 48px; padding: 0 24px; align-items: center; justify-content: center;
      border-radius: 14px; background: #d03868; color: #fff; font-weight: 700; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Opening Smittenz…</h1>
    <p>Your payment status will be confirmed securely inside the app.</p>
    <a href="smitten:///payment-complete">Open Smittenz</a>
  </div>
  <script>
    window.location.replace('smitten:///payment-complete');
  </script>
</body>
</html>`);
  });

  // Vault and memory media are private API resources. Never allow legacy files
  // in their old upload folders to become publicly reachable.
  app.use(['/uploads/vault', '/uploads/memories', '/uploads/chat'], (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  // Public profile avatars still live directly under /uploads.
  app.use('/uploads', express.static(uploadsDir, { index: false }));

  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/couple', coupleRoutes);
  app.use('/api/v1/payments', paymentRoutes);
  app.use('/api/v1/chat', chatRoutes);
  app.use('/api/v1/vault', vaultRoutes);
  app.use('/api/v1/memories', memoriesRoutes);
  app.use('/api/v1/notes', notesRoutes);
  app.use('/api/v1/special-moments', specialMomentsRoutes);
  app.use('/api/v1/notifications', notificationsRoutes);
  app.use('/api/v1/games', gamesRoutes);

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  return app;
}
