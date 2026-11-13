// OPTIONAL backend: receives Brevo webhooks and hands the events to the extension.
//
// Why a backend at all? Brevo delivers webhooks by calling a PUBLIC https URL. A browser extension cannot listen for incoming
// connections, so something with an address must catch the events. Without it VierCRM still works: it polls Brevo's own events API
// (Analytics → "Sync from Brevo", and every few minutes while Chrome is open). The webhook only makes updates near-instant.
//
//   node backend/webhook-server.mjs                # listens on 127.0.0.1:8788; expose it with a tunnel (Cloudflare Tunnel, ngrok…)
//
//   Brevo → Transactional → Settings → Webhook:  https://<your-tunnel>/brevo/webhook/<WEBHOOK_SECRET>     (events: delivered, opened, click, bounces, unsubscribed, spam, blocked)
//   VierCRM → Settings → Webhook backend:        the same base URL + the TOKEN (both are printed on first start and stored in backend/.state/)
//
// Security: the webhook URL carries a long random secret (Brevo cannot send custom headers); the extension reads events with a bearer
// token. Neither is a Brevo API key – the API key never leaves the extension. Nothing is logged except event types and message ids.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MAX_BODY = 256 * 1024; const MAX_EVENTS = 20000;

export function createWebhookServer({ dir, token, secret, now = () => Date.now() }) {
  fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, 'events.jsonl');
  let seq = 0; let events = [];
  if (fs.existsSync(file)) { events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); seq = events.at(-1)?.seq ?? 0; }
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const safeEq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/health') return json(res, 200, { ok: true, events: events.length });
    if (req.method === 'POST' && u.pathname.startsWith('/brevo/webhook/')) {
      if (!safeEq(u.pathname.slice('/brevo/webhook/'.length), secret)) return json(res, 403, { ok: false });
      let raw = ''; let tooBig = false;
      req.on('data', d => { raw += d; if (raw.length > MAX_BODY) { tooBig = true; req.destroy(); } });
      req.on('end', () => {
        if (tooBig) return;
        let body; try { body = JSON.parse(raw || '{}'); } catch { return json(res, 400, { ok: false, error: 'invalid JSON' }); }
        const list = Array.isArray(body) ? body : [body];
        for (const e of list) {
          if (!e || typeof e.event !== 'string') continue;
          const row = { seq: ++seq, receivedAt: new Date(now()).toISOString(), event: e.event, email: e.email, messageId: e['message-id'] || e.messageId, date: e.date || (e.ts_event ? new Date(e.ts_event * 1000).toISOString() : undefined), link: e.link, reason: e.reason };
          events.push(row); fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
        }
        if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
        json(res, 200, { ok: true, accepted: list.length });
      });
      return;
    }
    if (req.method === 'GET' && u.pathname === '/events') {
      if (!safeEq((req.headers.authorization || '').replace(/^Bearer /, ''), token)) return json(res, 401, { ok: false, error: 'bad token' });
      const since = Number(u.searchParams.get('since') || 0);
      const out = events.filter(e => e.seq > since).slice(0, 1000);
      return json(res, 200, { ok: true, events: out, next: out.at(-1)?.seq ?? since });
    }
    json(res, 404, { ok: false });
  });
  return server;
}

// run directly
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '.state'); fs.mkdirSync(dir, { recursive: true });
  const keep = (name, env) => { const f = path.join(dir, name); const v = process.env[env] || (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : ''); if (v) return v; const n = crypto.randomBytes(24).toString('hex'); fs.writeFileSync(f, n); return n; };
  const token = keep('token.txt', 'VIER_WEBHOOK_TOKEN'); const secret = keep('secret.txt', 'VIER_WEBHOOK_SECRET'); const port = Number(process.env.PORT || 8788);
  createWebhookServer({ dir, token, secret }).listen(port, '127.0.0.1', () => {
    console.log(`VierCRM webhook backend on http://127.0.0.1:${port}`);
    console.log(`  Brevo webhook path : /brevo/webhook/${secret}`);
    console.log(`  Extension token    : ${token}`);
    console.log('  Expose it with a tunnel and use the HTTPS URL in Brevo and in VierCRM → Settings → Webhook backend.');
  });
}
