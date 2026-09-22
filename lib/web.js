'use strict';
// Local inbox dashboard: a small zero-dependency web client over the read-
// receipt store (lib/inbox). Binds 127.0.0.1 only, and additionally requires
// the install token on every /api/* call plus a loopback Host header - the page
// exposes message text and an ack endpoint, so a rebound DNS name or a foreign
// page must not be able to read or write it.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { homedir } = require('os');
const { randomBytes, timingSafeEqual } = require('crypto');
const { protectPath, aggregateAcl, PRIVATE } = require('./secure-fs');

const TOKEN_FILE_NAME = 'openacom-web.token';
const TOKEN_PLACEHOLDER = '__OA_TOKEN__';
const TOKEN_HEADER = 'x-openacom-token';

const homeDir = () => process.env.AGENTRELAY_HOME || path.join(homedir(), '.openacom');
const TOKEN_FILE = () => path.join(homeDir(), TOKEN_FILE_NAME);

let _tokenAcl = null;

// The token file and its directory, protected once per process: on Windows each
// protection spawns icacls, so this must not run per request. An existing file
// is tightened too - a token written by an older version inherited its
// directory's access until something opened it.
function protectTokenTree(dir, file) {
  if (_tokenAcl === null) _tokenAcl = aggregateAcl([protectPath(dir, { directory: true }), protectPath(file)]);
  return _tokenAcl;
}

// Returns { token, created, file, acl }. `acl` is null when no file is involved
// (the operator pinned the token in the environment).
function loadToken() {
  const fromEnv = process.env.AGENTRELAY_WEB_TOKEN;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return { token: fromEnv.trim(), created: false, file: null, acl: null };
  const file = TOKEN_FILE();
  const dir = path.dirname(file);
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved) return { token: saved, created: false, file, acl: protectTokenTree(dir, file) };
  } catch { /* generate below */ }
  const token = randomBytes(24).toString('hex');
  let acl = PRIVATE;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
    acl = protectTokenTree(dir, file);
  } catch { /* in-memory token still guards this process */ }
  return { token, created: true, file, acl };
}

// A rebinding attack reaches us with the attacker's Host header; anything that
// is not our own loopback origin is refused.
function hostAllowed(header, port) {
  const h = String(header || '').trim().toLowerCase();
  const m = h.match(/^(127\.0\.0\.1|localhost)(?::(\d{1,5}))?$/);
  if (!m) return false;
  return m[2] === undefined || Number(m[2]) === Number(port);
}

function tokenAllowed(present, expected) {
  const a = Buffer.from(String(present || ''), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function injectToken(html, token) {
  return html.split(TOKEN_PLACEHOLDER).join(JSON.stringify(String(token)).replace(/</g, '\\u003c'));
}

function startWeb(port = 9339, { open = true, token } = {}) {
  const inbox = require('./inbox');
  const provided = typeof token === 'string' && token.trim();
  const loaded = provided ? { token: token.trim(), created: false, file: null, acl: null } : loadToken();
  const secret = loaded.token;
  const state = { port };
  const server = http.createServer((req, res) => {
    const origin = `http://127.0.0.1:${state.port}`;
    const cors = { 'Access-Control-Allow-Origin': origin, 'X-Content-Type-Options': 'nosniff' };
    const send = (code, body, extra = {}) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...cors, ...extra });
      res.end(body);
    };
    const json = (code, body) => send(code, JSON.stringify(body));
    const url = new URL(req.url, 'http://127.0.0.1');
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
    try {
      if (!hostAllowed(req.headers.host, state.port)) return json(403, { error: 'forbidden host' });
      if (isApi && req.method === 'OPTIONS') {
        return send(204, '', {
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': `Content-Type, ${TOKEN_HEADER}`,
          'Access-Control-Max-Age': '600',
        });
      }
      if (isApi && !tokenAllowed(req.headers[TOKEN_HEADER], secret)) return json(401, { error: 'unauthorized' });
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const page = injectToken(fs.readFileSync(path.join(__dirname, 'web-page.html'), 'utf8'), secret);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...cors });
        res.end(page);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/docs') {
        const page = injectToken(fs.readFileSync(path.join(__dirname, 'docs-page.html'), 'utf8'), secret);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...cors });
        res.end(page);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/meta') {
        json(200, { version: require('../package.json').version, hooks: require('./hooks').EVENTS });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/stats') {
        const counts = { pending: 0, sent: 0, read: 0, failed: 0 };
        for (const r of inbox.list({ limit: 10000 })) counts[r.status] = (counts[r.status] || 0) + 1;
        json(200, counts);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/messages') {
        const status = url.searchParams.get('status');
        const limit = Number(url.searchParams.get('limit')) || 100;
        json(200, inbox.list({ status: status || undefined, limit }));
        return;
      }
      const detail = url.pathname.match(/^\/api\/messages\/([a-f0-9-]+)$/);
      if (req.method === 'GET' && detail) {
        const row = inbox.get(detail[1]);
        if (!row) return json(404, { error: 'unknown id' });
        json(200, row);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/ack') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          try {
            const { id } = JSON.parse(body || '{}');
            const row = inbox.markRead(String(id || ''));
            json(200, { ok: true, id: row.id, status: row.status });
          } catch (e) { json(400, { error: e.message }); }
        });
        return;
      }
      json(404, { error: 'not found' });
    } catch (e) {
      json(500, { error: e.message });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      state.port = server.address().port;
      const url = `http://127.0.0.1:${state.port}`;
      if (loaded.created) {
        console.error(`OpenAcom web token: ${secret}` + (loaded.file ? `  (saved to ${loaded.file}, keep it private)` : '  (set AGENTRELAY_WEB_TOKEN to pin it)'));
      }
      if (loaded.acl && loaded.acl !== PRIVATE) {
        // Never echo the token here: this reminder exists because the file may be
        // readable by other accounts, and stderr of a dashboard run often is archived.
        console.error(`OpenAcom web token file kept inherited access (${loaded.acl}) - tighten ${loaded.file} with icacls/chmod, or pin AGENTRELAY_WEB_TOKEN in a private location`);
      }
      if (open && process.platform === 'win32') {
        const { spawn } = require('child_process');
        spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
      }
      console.log(`OpenAcom inbox dashboard on ${url}  (Ctrl-C to stop)`);
      server.openacomToken = secret;
      resolve(server);
    });
  });
}

module.exports = { startWeb, TOKEN_FILE, loadToken, hostAllowed, tokenAllowed };
