'use strict';
// Local inbox dashboard: a small zero-dependency web client over the read-
// receipt store (lib/inbox). Binds 127.0.0.1 only - it exposes message text
// and an ack endpoint, so never expose it beyond localhost.
const http = require('http');
const fs = require('fs');
const path = require('path');

function startWeb(port = 9339, { open = true } = {}) {
  const inbox = require('./inbox');
  const server = http.createServer((req, res) => {
    const json = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const page = fs.readFileSync(path.join(__dirname, 'web-page.html'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/docs') {
        const page = fs.readFileSync(path.join(__dirname, 'docs-page.html'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
      const url = `http://127.0.0.1:${port}`;
      if (open && process.platform === 'win32') {
        const { spawn } = require('child_process');
        spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
      }
      console.log(`OpenAcom inbox dashboard on ${url}  (Ctrl-C to stop)`);
      resolve(server);
    });
  });
}

module.exports = { startWeb };
