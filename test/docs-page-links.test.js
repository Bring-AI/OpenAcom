'use strict';
// Wave 10 (#15): the local /docs page must not point at a dead owner/path, and it
// must still be the Chinese page with the wave-3 token wiring intact. Served for
// real on a random port and read back, because "the source no longer says it" is
// not the claim - "the page the user opens no longer says it" is.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'openacom-docs-'));
process.env.AGENTRELAY_HOME = home;
delete process.env.AGENTRELAY_WEB_TOKEN;

const web = require('../lib/web');

const get = (port, p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  }).on('error', reject);
});

let server;
let docs;

test('serving /docs on a random port answers 200 with the canonical repository', async () => {
  server = await web.startWeb(0, { open: false });
  const port = server.address().port;
  const res = await get(port, '/docs');
  assert.equal(res.status, 200);
  docs = res.body;
  assert.ok(docs.includes('OpenAcom 文档'), 'the served page is the docs page, not a fallback');
  assert.ok(!/wwy155/i.test(docs), `a dead path survived into the served page: ${(docs.match(/.{0,60}wwy155.{0,60}/i) || [''])[0]}`);
  assert.equal((docs.match(/github\.com\/Bring-AI\/OpenAcom/g) || []).length, 2, 'both README links point at canonical');
  assert.equal((docs.match(/github:Bring-AI\/OpenAcom/g) || []).length, 2, 'install command and the SDK line');
});

test('the private-repo caveat is on the page and no public-npm install is suggested', () => {
  assert.match(docs, /私有仓库/);
  assert.match(docs, /公共 npm 上没有/);
  // The bare form may only appear inside that warning, never as an instruction.
  const hits = [...docs.matchAll(/<code>npm install openacom<\/code>/g)];
  assert.equal(hits.length, 1, 'exactly one mention of the public-npm form');
  assert.match(docs.slice(0, hits[0].index).slice(-200), /公共 npm 上没有/, 'and it is the "this does not exist" sentence');
});

test('the page stays Chinese and keeps the token wiring Docs/wave 3 rely on', () => {
  assert.match(docs, /<html lang="zh-CN">/, 'language untouched');
  assert.ok(/[一-鿿]/.test(docs), 'still a Chinese document page');
  assert.match(docs, /X-OpenAcom-Token/, 'the dashboard auth note the pages depend on is still there');
  assert.match(docs, /__OPENACOM_TOKEN__/, 'and the injected token plumbing too');
});

test('the source file and the served page agree', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'docs-page.html'), 'utf8');
  assert.equal(/wwy155/i.test(src), false);
  assert.ok(docs.includes('npm install -g github:Bring-AI/OpenAcom'), 'what the file says is what the user is served');
});

test('cleanup', async () => {
  if (server) await new Promise((resolve) => { server.close(resolve); });
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
  assert.equal(fs.existsSync(home), false);
});
