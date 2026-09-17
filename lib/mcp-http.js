'use strict';
// Streamable-HTTP MCP transport: POST /mcp with a JSON-RPC message, get a plain
// JSON response (no server-initiated streams; GET returns 405 as allowed).
// Binds 127.0.0.1 only - pair with an SSH tunnel for remote access.
const http = require('http');
const { handleMessage } = require('./mcp');

function runHttp(port = 9321) {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && (req.url === '/mcp' || req.url === '/')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const respond = (out) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(out ? JSON.stringify(out) : JSON.stringify({ jsonrpc: '2.0', result: {} }));
        };
        let msg = null;
        try {
          msg = JSON.parse(body);
        } catch (e) {
          respond({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error: ' + e.message } });
          return;
        }
        // handleMessage may be async (blocking sends).
        Promise.resolve()
          .then(() => handleMessage(msg))
          .then(respond)
          .catch((e) => respond({ jsonrpc: '2.0', id: (msg && msg.id) ?? null, error: { code: -32603, message: e.message } }));
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, server: 'agentrelay' }));
      return;
    }
    if (req.method === 'DELETE' || req.method === 'GET') {
      res.writeHead(405).end();
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, '127.0.0.1', () => {
    process.stderr.write(`agentrelay MCP (streamable-http) on http://127.0.0.1:${port}/mcp\n`);
  });
}
module.exports = { runHttp };
