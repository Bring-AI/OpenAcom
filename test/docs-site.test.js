'use strict';
// Self-proof for the generated documentation site (tools/gen-docs.js).
// Pins the five invariants the wave brief demands, plus link integrity,
// determinism and the no-external-resources rule. Run with:
//   node --test test/docs-site.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const gen = require('../tools/gen-docs.js');

const ROOT = gen.ROOT;
const DOCS = path.join(ROOT, 'docs');

// CJK + fullwidth ranges: Hangul, CJK radicals/ideographs, compatibility forms.
const CJK_RANGES = [
  [0x1100, 0x11ff], [0x2e80, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7ff],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xffef], [0x20000, 0x2ffff],
];
function cjkCount(text) {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    for (const [a, b] of CJK_RANGES) if (c >= a && c <= b) { n++; break; }
  }
  return n;
}

function listPages(dir) {
  const out = [];
  (function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.html')) out.push(p);
    }
  })(dir);
  return out.sort();
}

function tagProblems(html) {
  const VOID = new Set(['meta', 'link', 'br', 'hr', 'img', 'input', 'source', 'wbr', 'area', 'base', 'col', 'embed', 'track']);
  const stack = [];
  const problems = [];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*?)(\/?)>/g)) {
    const tag = m[2].toLowerCase();
    if (VOID.has(tag) || m[4] === '/') continue;
    if (m[1] === '/') {
      const top = stack.pop();
      if (top !== tag) problems.push(`closing /${tag} but innermost open was ${top}`);
    } else stack.push(tag);
  }
  if (stack.length) problems.push('never closed: ' + stack.join(','));
  return problems;
}

// The generator is the subject under test: build the real docs/ once per run.
test.before(() => {
  gen.buildSite(ROOT, DOCS);
});

test('generator writes the full bilingual page set', () => {
  const pages = listPages(DOCS);
  assert.strictEqual(pages.length, gen.PAGES.length * 2);
  for (const page of gen.PAGES) {
    for (const lang of ['', 'zh/']) {
      const file = path.join(DOCS, lang + page + '.html');
      assert.ok(fs.existsSync(file), `missing ${lang}${page}.html`);
      assert.ok(fs.statSync(file).size > 2000, `${lang}${page}.html is suspiciously small`);
    }
  }
});

test('english pages document every MCP tool, HELP flag and SDK export', () => {
  const model = gen.collect(ROOT);
  const en = listPages(DOCS).filter((f) => !f.includes(`${path.sep}zh${path.sep}`))
    .map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  for (const tool of model.tools) {
    assert.ok(en.includes(tool.name), `EN docs omit MCP tool ${tool.name}`);
  }
  for (const flag of model.cli.helpFlags) {
    assert.ok(en.includes(flag), `EN docs omit HELP flag ${flag}`);
  }
  for (const name of Object.keys(model.sdk.runtime)) {
    assert.ok(en.includes(name), `EN docs omit SDK export ${name}`);
  }
  // The reference tables must carry the schema detail, not just the names.
  for (const tool of model.tools) {
    for (const param of tool.params) assert.ok(en.includes(param.name), `EN docs omit ${tool.name} param ${param.name}`);
  }
});

test('english pages contain zero CJK characters', () => {
  for (const file of listPages(DOCS)) {
    if (file.includes(`${path.sep}zh${path.sep}`)) continue;
    const html = fs.readFileSync(file, 'utf8');
    assert.strictEqual(cjkCount(html), 0, `${path.relative(ROOT, file)} contains CJK characters`);
  }
});

test('chinese pages exist and do carry CJK (the split is real)', () => {
  const zh = listPages(DOCS).filter((f) => f.includes(`${path.sep}zh${path.sep}`));
  assert.ok(zh.length === gen.PAGES.length);
  for (const file of zh) {
    assert.ok(cjkCount(fs.readFileSync(file, 'utf8')) > 0, `${path.relative(ROOT, file)} has no Chinese content`);
  }
});

test('no page anywhere mentions the dead wwy155 remote', () => {
  for (const file of listPages(DOCS)) {
    assert.ok(!/wwy155/i.test(fs.readFileSync(file, 'utf8')), `${path.relative(ROOT, file)} mentions wwy155`);
  }
});

test('generated HTML tags balance', () => {
  for (const file of listPages(DOCS)) {
    const problems = tagProblems(fs.readFileSync(file, 'utf8'));
    assert.deepStrictEqual(problems, [], `${path.relative(ROOT, file)}: ${problems.join('; ')}`);
  }
});

test('internal links and anchors all resolve', () => {
  const pages = listPages(DOCS);
  const ids = new Map(pages.map((f) => [path.resolve(f), new Set([...fs.readFileSync(f, 'utf8').matchAll(/ id="([^"]+)"/g)].map((m) => m[1]))]));
  for (const file of pages) {
    const html = fs.readFileSync(file, 'utf8');
    for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const href = m[1];
      if (/^(https?:|mailto:)/.test(href)) continue;
      const [filePart, anchor] = href.split('#');
      const target = filePart ? path.resolve(path.dirname(file), filePart) : path.resolve(file);
      assert.ok(fs.existsSync(target), `${path.relative(ROOT, file)} links to missing ${href}`);
      if (anchor) assert.ok(ids.get(path.resolve(target)).has(anchor), `${path.relative(ROOT, file)} links to missing anchor ${href}`);
    }
  }
});

test('pages are self-contained: no CDN, web fonts or external scripts', () => {
  for (const file of listPages(DOCS)) {
    const html = fs.readFileSync(file, 'utf8');
    assert.ok(!/<script[^>]+\bsrc=/i.test(html), `${path.relative(ROOT, file)} loads an external script`);
    assert.ok(!/<link[^>]+href="https?:/i.test(html), `${path.relative(ROOT, file)} links an external resource`);
    assert.ok(!/@import|url\(https?:/i.test(html), `${path.relative(ROOT, file)} pulls external CSS assets`);
    assert.ok(html.includes('name="viewport"'), `${path.relative(ROOT, file)} has no viewport meta`);
    assert.ok(html.includes('.tablewrap{overflow-x:auto'), `${path.relative(ROOT, file)} lacks the narrow-screen table guard`);
  }
});

test('output is deterministic across two builds', () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-docs-a-'));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-docs-b-'));
  try {
    gen.buildSite(ROOT, a);
    gen.buildSite(ROOT, b);
    for (const rel of listPages(a).map((f) => path.relative(a, f))) {
      assert.strictEqual(fs.readFileSync(path.join(a, rel), 'utf8'), fs.readFileSync(path.join(b, rel), 'utf8'), rel + ' differs between builds');
    }
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test('generator refuses to run against missing sources instead of emitting empty pages', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-docs-empty-'));
  try {
    assert.throws(() => gen.collect(empty), /required source is missing: README\.md/);
    assert.throws(() => gen.buildSite(empty, path.join(empty, 'docs')), /required source is missing/);
    assert.ok(!fs.existsSync(path.join(empty, 'docs')), 'no output dir may appear for a failed build');
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }

  // A tree that is complete except one derived source must name that source.
  const partial = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-docs-partial-'));
  try {
    for (const rel of gen.REQUIRED_SOURCES) {
      if (rel === 'lib/groups.js') continue;
      const from = path.join(ROOT, rel);
      const to = path.join(partial, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
    assert.throws(() => gen.collect(partial), /required source is missing: lib\/groups\.js/);
  } finally {
    fs.rmSync(partial, { recursive: true, force: true });
  }
});
