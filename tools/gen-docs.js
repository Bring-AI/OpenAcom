#!/usr/bin/env node
'use strict';
// OpenAcom documentation site generator.
//
// Rule of this file: the site is DERIVED, never pasted. Prose is parsed out of
// README.md (English half = everything before the "## 中文说明" heading, Chinese
// half = everything after it); every API surface is extracted from the source
// tree (lib/mcp.js TOOLS, bin/openacom.js HELP + parseArgs, lib/index.js exports
// with implementations in lib/sdk.js, relay error codes / limits / identity from
// lib/distributed.js, lib/desktop-delivery.js, lib/groups.js). Nothing here
// restates documentation in its own words, so the pages cannot drift from the
// code or the README. The only hand-written strings are UI chrome (nav labels,
// table headers), kept in the I18N dictionaries below.
//
// Usage: node tools/gen-docs.js            (writes docs/ and docs/zh/, then exits)
// Zero dependencies; serves nothing; deterministic output (no timestamps).

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

// Every file the site is derived from. A missing one is a hard error: silently
// emitting a page without its source would be exactly the drift this tool
// exists to prevent.
const REQUIRED_SOURCES = [
  'README.md',
  'package.json',
  'bin/openacom.js',
  'lib/mcp.js',
  'lib/index.js',
  'lib/sdk.js',
  'lib/distributed.js',
  'lib/distributed-cli.js',
  'lib/desktop-delivery.js',
  'lib/groups.js',
  'lib/delivery.js',
];

const README_SPLIT = '## 中文说明';
const BACKSLASH = '\\';

function readSource(root, rel) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`gen-docs: required source is missing: ${rel} (expected ${file}); refusing to generate a partial site`);
  }
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

// ---------------------------------------------------------------------------
// Literal slicing: cut a balanced [ ... ] or { ... } out of source text,
// string-aware, so it can be evaluated or rendered verbatim.
// ---------------------------------------------------------------------------
function sliceLiteral(src, decl, open, close) {
  const at = src.indexOf(decl);
  if (at < 0) throw new Error(`gen-docs: declaration not found: ${JSON.stringify(decl)}`);
  const start = src.indexOf(open, at);
  if (start < 0) throw new Error(`gen-docs: no "${open}" after ${JSON.stringify(decl)}`);
  let depth = 0;
  let quote = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === BACKSLASH) i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`gen-docs: unbalanced literal after ${JSON.stringify(decl)}`);
}

function evalLiteral(text) {
  return vm.runInNewContext(`(${text})`, Object.create(null), { timeout: 2000 });
}

// Realm-safe serializer for values produced inside the vm sandbox.
function showValue(value) {
  const tag = Object.prototype.toString.call(value);
  if (tag === '[object RegExp]') return String(value);
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v : showValue(v)));
  return value;
}

// The first sentence of the contiguous // comment block sitting directly above
// `lineIndex` (0-based). Returns null when there is no comment to quote.
function commentAbove(lines, lineIndex) {
  let end = lineIndex - 1;
  while (end >= 0 && lines[end].trim() === '') end--;
  if (end < 0 || !/^\s*\/\//.test(lines[end])) return null;
  let start = end;
  while (start - 1 >= 0 && /^\s*\/\//.test(lines[start - 1])) start--;
  const text = lines.slice(start, end + 1)
    .map((l) => l.replace(/^\s*\/\/\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  const sentence = /^(.*?(?:[.!?](?:\s|$)|$))/.exec(text)[1].trim();
  return sentence || text;
}

// ---------------------------------------------------------------------------
// MCP tools (lib/mcp.js)
// ---------------------------------------------------------------------------
function extractTools(src) {
  const tools = evalLiteral(sliceLiteral(src, 'const TOOLS =', '[', ']'));
  if (!Array.isArray(tools) || tools.length === 0) throw new Error('gen-docs: lib/mcp.js TOOLS is empty or not an array');
  return tools.map((tool, i) => {
    if (!tool || typeof tool.name !== 'string' || typeof tool.description !== 'string' || !tool.inputSchema) {
      throw new Error(`gen-docs: lib/mcp.js TOOLS[${i}] is missing name/description/inputSchema`);
    }
    const schema = tool.inputSchema;
    const props = schema.properties || {};
    const required = schema.required || [];
    return {
      name: tool.name,
      description: tool.description,
      index: i,
      params: Object.keys(props).map((key) => ({
        name: key,
        type: props[key].type || 'any',
        required: required.includes(key),
        def: props[key].default,
        hasDefault: Object.prototype.hasOwnProperty.call(props[key], 'default'),
        enum: props[key].enum || null,
        description: props[key].description || null,
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// CLI surface (bin/openacom.js + lib/distributed-cli.js)
// ---------------------------------------------------------------------------
function extractHelp(src, file) {
  const m = /const HELP = `([\s\S]*?)`;/m.exec(src);
  if (!m) throw new Error(`gen-docs: no HELP template literal in ${file}`);
  return { text: m[1], line: lineOf(src, m.index) };
}

function extractUsageLines(helpText) {
  const out = [];
  for (const raw of helpText.split('\n')) {
    const m = /^\s{2,}openacom\s+(\S.*)$/.exec(raw);
    if (!m) continue;
    const cmd = m[1].split(/\s+/)[0];
    const last = out[out.length - 1];
    if (last && last.cmd === cmd) last.lines.push(raw.trim());
    else out.push({ cmd, lines: [raw.trim()] });
  }
  return out;
}

function extractFlags(helpText) {
  const seen = [];
  for (const m of helpText.matchAll(/(?<![\w-])(--?[a-z][a-z0-9-]*)/g)) {
    if (!seen.includes(m[1])) seen.push(m[1]);
  }
  return seen;
}

function extractParseArgs(src, file) {
  const m = /function parseArgs\(argv\) \{([\s\S]*?)\n\}/.exec(src);
  if (!m) throw new Error(`gen-docs: parseArgs not found in ${file}`);
  const base = lineOf(src, m.index);
  const out = [];
  m[1].split('\n').forEach((line, i) => {
    const names = [...line.matchAll(/'(--[a-zA-Z0-9-]+|-[a-zA-Z])'/g)].map((x) => x[1]);
    if (!names.length) return;
    const dest = /flags\.([A-Za-z0-9_]+)\s*=/.exec(line);
    let kind = 'boolean';
    if (/parseBool\(/.test(line)) kind = 'true|false';
    else if (/parseInt\(/.test(line)) kind = 'integer';
    else if (/requireNext\(/.test(line)) kind = 'string value';
    else if (/argv\[\+\+i\]/.test(line)) kind = 'string value';
    else if (/=\s*false\b/.test(line)) kind = 'boolean (off)';
    out.push({ flags: names, dest: dest ? dest[1] : null, kind, line: base + i + 1 });
  });
  if (!out.length) throw new Error(`gen-docs: parseArgs in ${file} yielded no flags`);
  return out;
}

function extractSubcommands(src) {
  const m = /async function main\(\) \{([\s\S]*?)\n\}/.exec(src);
  if (!m) throw new Error('gen-docs: main() not found in bin/openacom.js');
  const base = lineOf(src, m.index);
  const out = [];
  m[1].split('\n').forEach((line, i) => {
    const early = /if \(cmd === '([a-z0-9-]+)'\)/.exec(line);
    const sw = /case '([a-z0-9-]+)':\s*return\s+(.*?);\s*$/.exec(line.trim());
    if (early) {
      const req = /require\('([^']+)'\)/.exec(line);
      out.push({ name: early[1], handler: req ? req[1] : null, line: base + i + 1 });
    } else if (sw) {
      out.push({ name: sw[1], handler: sw[2].trim(), line: base + i + 1 });
    }
  });
  if (!out.length) throw new Error('gen-docs: no subcommands found in bin/openacom.js main()');
  return out;
}

function extractRelayCli(src) {
  const help = extractHelp(src, 'lib/distributed-cli.js');
  const options = evalLiteral(sliceLiteral(src, 'const options = {', '{', '}'));
  const terminal = /parse\(argv\.slice\(0, split\), (\[[^\]]*\])\)/.exec(src);
  return { help, options, terminalFlags: terminal ? evalLiteral(terminal[1]) : [] };
}

// ---------------------------------------------------------------------------
// SDK surface (lib/index.js public entry, lib/sdk.js implementation)
// ---------------------------------------------------------------------------
function extractSdk(root) {
  const indexSrc = readSource(root, 'lib/index.js');
  const sdkSrc = readSource(root, 'lib/sdk.js');
  let api;
  try {
    api = require(path.join(root, 'lib', 'index.js'));
  } catch (error) {
    throw new Error(`gen-docs: cannot require lib/index.js (the public SDK entry): ${error.message}`);
  }
  const files = [
    { rel: 'lib/index.js', src: indexSrc, lines: indexSrc.split('\n') },
    { rel: 'lib/sdk.js', src: sdkSrc, lines: sdkSrc.split('\n') },
  ];

  function findFunction(file, name) {
    const re = new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(([^)]*)\\)`, 'm');
    const m = re.exec(file.src);
    if (!m) return null;
    const line = lineOf(file.src, m.index);
    return { file, kind: 'function', params: m[1].trim(), line, summary: commentAbove(file.lines, line - 1) };
  }
  function findConst(file, name) {
    const re = new RegExp(`^const\\s+${name}\\s*=`, 'm');
    const m = re.exec(file.src);
    if (!m) return null;
    const line = lineOf(file.src, m.index);
    return { file, kind: 'namespace', params: '', line, summary: commentAbove(file.lines, line - 1) };
  }
  function findArrowMember(file, name) {
    const re = new RegExp(`^\\s*${name}:\\s*(?:async\\s*)?(?:function\\s*)?\\(([^)]*)\\)`, 'm');
    const m = re.exec(file.src);
    if (!m) return null;
    const line = lineOf(file.src, m.index);
    return { file, kind: 'function', params: m[1].trim(), line, summary: commentAbove(file.lines, line - 1) };
  }
  function locate(name) {
    for (const file of files) {
      const fn = findFunction(file, name);
      if (fn) return fn;
      // `name: sdk.x` indirection in the public entry.
      const alias = new RegExp(`^\\s*${name}:\\s*sdk\\.(\\w+)`, 'm').exec(file.src);
      if (alias) {
        for (const target of files) {
          const inner = findFunction(target, alias[1]) || findConst(target, alias[1]);
          if (inner) return inner;
        }
      }
      const konst = findConst(file, name);
      if (konst) return konst;
      const arrow = findArrowMember(file, name);
      if (arrow) return arrow;
      // `name: identifier` pointing at a local binding in the other file.
      const ref = new RegExp(`^\\s*${name}:\\s*([a-z]\\w*)\\s*,?\\s*$`, 'm').exec(file.src);
      if (ref) {
        for (const target of files) {
          const inner = findFunction(target, ref[1]) || findConst(target, ref[1]);
          if (inner) return inner;
        }
      }
    }
    return null;
  }

  const exportsList = [];
  for (const name of Object.keys(api)) {
    const value = api[name];
    const located = locate(name);
    const entry = {
      name,
      kind: typeof value === 'function' ? 'function' : (value && typeof value === 'object' ? 'namespace' : typeof value),
      params: located ? located.params : '',
      source: located ? `${located.file.rel}:${located.line}` : null,
      summary: located ? located.summary : null,
      members: [],
    };
    if (entry.kind === 'namespace' && value && typeof value === 'object') {
      for (const memberName of Object.keys(value)) {
        const member = value[memberName];
        let memberLocated = null;
        for (const file of files) {
          memberLocated = findArrowMember(file, memberName) || findFunction(file, memberName);
          if (memberLocated) break;
        }
        entry.members.push({
          name: memberName,
          kind: typeof member === 'function' ? 'function' : typeof member,
          params: memberLocated ? memberLocated.params : '',
          source: memberLocated ? `${memberLocated.file.rel}:${memberLocated.line}` : null,
          summary: memberLocated ? memberLocated.summary : null,
        });
      }
    }
    exportsList.push(entry);
  }

  const headerMatch = /((?:^\/\/[^\n]*\n?){2,})/m.exec(indexSrc);
  const todos = [];
  const walk = (list, prefix) => {
    for (const item of list) {
      if (item.kind === 'function' && !item.summary) todos.push(prefix + item.name);
      if (item.members && item.members.length) walk(item.members, `${prefix + item.name}.`);
    }
  };
  walk(exportsList, 'relay.');

  // SDK-side error annotation tables, straight from lib/sdk.js.
  const derived = [];
  const derivedLiteral = /const DERIVED_CODES = (\[[\s\S]*?\]);/.exec(sdkSrc);
  if (derivedLiteral) {
    for (const pair of showValue(evalLiteral(derivedLiteral[1]))) {
      if (Array.isArray(pair) && pair.length === 2) derived.push({ pattern: String(pair[0]), code: pair[1] });
    }
  }
  const certainLiteral = /const CERTAIN_CODES = new Set\((\[[\s\S]*?\])\)/.exec(sdkSrc);
  const certain = certainLiteral ? showValue(evalLiteral(certainLiteral[1])) : [];

  return { exports: exportsList, header: headerMatch ? headerMatch[1].trim() : '', todos, runtime: api, derived, certain };
}

// ---------------------------------------------------------------------------
// Relay semantics: error codes, code sets, limits, identity, groups
// ---------------------------------------------------------------------------
function splitArgs(src, openParenIndex) {
  const args = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (let i = openParenIndex; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      current += c;
      if (c === BACKSLASH) { current += src[++i] || ''; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; current += c; continue; }
    if (c === '(' || c === '[' || c === '{') { if (depth > 0) current += c; depth++; continue; }
    if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0 && c === ')') { args.push(current.trim()); return args; }
      current += c;
      continue;
    }
    if (c === ',' && depth === 1) { args.push(current.trim()); current = ''; continue; }
    if (depth >= 1) current += c;
  }
  return args;
}

function literalString(arg) {
  if (!arg) return null;
  const m = /^(['"`])([\s\S]*)\1$/.exec(arg);
  if (!m) return null;
  return m[2].replace(/\$\{[^}]*\}/g, '<value>').replace(/\\'/g, "'").replace(/\s+/g, ' ').trim();
}

function firstSentence(text, cap = 240) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  const m = /^(.{0,400}?[.!?])(\s|$)/.exec(clean);
  const sentence = m ? m[1] : clean;
  return sentence.length > cap ? `${sentence.slice(0, cap - 1)}…` : sentence;
}

function extractErrorCodes(root, files) {
  const codes = new Map();
  const note = (code, info) => {
    if (!/^[A-Z][A-Z0-9_]{2,}$/.test(code)) return;
    if (!codes.has(code)) codes.set(code, { code, status: null, meaning: null, sites: [] });
    const row = codes.get(code);
    if (info.status && !row.status) row.status = info.status;
    if (info.meaning && !row.meaning) row.meaning = info.meaning;
    row.sites.push(`${info.file}:${info.line}`);
  };
  for (const rel of files) {
    const src = readSource(root, rel);
    for (const m of src.matchAll(/\b(fault|failWith|failure)\s*\(/g)) {
      const args = splitArgs(src, m.index + m[0].length - 1);
      let status = null;
      let codeArg = args[0];
      let msgArg = args[1];
      if (/^\d{3}$/.test(codeArg || '')) { status = codeArg; codeArg = args[1]; msgArg = args[2]; }
      const code = literalString(codeArg);
      if (!code) continue;
      const message = literalString(msgArg);
      note(code, { status, meaning: message ? firstSentence(message) : null, file: rel, line: lineOf(src, m.index) });
    }
    for (const m of src.matchAll(/code:\s*'([A-Z][A-Z0-9_]{2,})'/g)) {
      // Codes raised as Object.assign(new Error('...'), { code }) carry their
      // message a few characters earlier.
      const before = src.slice(Math.max(0, m.index - 500), m.index);
      const err = [...before.matchAll(/new Error\((['"`])([\s\S]*?)\1/g)].pop();
      note(m[1], { status: null, meaning: err ? firstSentence(literalString(err[1] + err[2] + err[1])) : null, file: rel, line: lineOf(src, m.index) });
    }
  }
  if (!codes.size) throw new Error('gen-docs: no error codes extracted; the fault()/failure() shapes changed');
  return [...codes.values()].sort((a, b) => a.code.localeCompare(b.code));
}

function extractCodeSets(root, rel, names) {
  const src = readSource(root, rel);
  const lines = src.split('\n');
  const out = [];
  for (const name of names) {
    const decl = src.indexOf(`const ${name} =`);
    if (decl < 0) continue;
    const value = showValue(evalLiteral(sliceLiteral(src, `const ${name} =`, '[', ']')));
    if (!Array.isArray(value)) continue;
    out.push({ name, file: rel, line: lineOf(src, decl), values: value, summary: commentAbove(lines, lineOf(src, decl) - 1) });
  }
  return out;
}

function extractLimits(root, rel) {
  const src = readSource(root, rel);
  const lines = src.split('\n');
  const out = [];
  const known = { HOUR: 3600000 };
  lines.forEach((line, i) => {
    const m = /^const ([A-Z][A-Z0-9_]*)\s*=\s*(.+?);\s*$/.exec(line);
    if (!m) return;
    const name = m[1];
    const expr = m[2];
    let value = null;
    if (/^[\d\s*]+$/.test(expr) || /^(\d+|[A-Z][A-Z0-9_]*)(\s*\*\s*(\d+|[A-Z][A-Z0-9_]*))+$/.test(expr)) {
      try { value = vm.runInNewContext(expr, Object.assign(Object.create(null), known), { timeout: 500 }); } catch { value = null; }
    } else if (/^\/.+\/[a-z]*$/.test(expr)) {
      value = expr;
    } else {
      return;
    }
    const window = src.slice(Math.max(0, m.index - 200), m.index + 400);
    const env = (window.match(/process\.env\.([A-Z0-9_]+)/) || [])[1] || null;
    out.push({ name, value, env, file: rel, line: i + 1, summary: commentAbove(lines, i) });
  });
  return out;
}

function extractIdentity(root) {
  const src = readSource(root, 'lib/desktop-delivery.js');
  const literal = sliceLiteral(src, 'const CDP_IDENTITY = Object.freeze({', '{', '}');
  const fields = [];
  for (const m of literal.matchAll(/(\w+):\s*(\/(?:[^/\\\n]|\\.)+\/[a-z]*)/g)) fields.push({ name: m[1], pattern: m[2] });
  if (!fields.length) throw new Error('gen-docs: CDP_IDENTITY fields not parseable in lib/desktop-delivery.js');
  const consent = showValue(evalLiteral(sliceLiteral(src, 'const CONSENT_ENV =', '[', ']')));
  return { fields, consentEnv: Array.isArray(consent) ? consent : [], line: lineOf(src, src.indexOf('const CDP_IDENTITY')) };
}

function extractGroups(root) {
  const src = readSource(root, 'lib/groups.js');
  const fileExpr = /const GROUPS_FILE = \(\) => ([^\n;]+);/.exec(src);
  const maxChars = /const MAX_FILE_CHARS = (\d+);/.exec(src);
  return {
    fileExpr: fileExpr ? fileExpr[1].trim() : null,
    maxChars: maxChars ? Number(maxChars[1]) : null,
    env: [...new Set([...src.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]))],
  };
}

// ---------------------------------------------------------------------------
// HTML escaping + inline markdown
// ---------------------------------------------------------------------------
function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escapeAttr(text) {
  return escapeHtml(text).replace(/'/g, '&#39;');
}

function inline(text, ctx) {
  let s = escapeHtml(text);
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (all, body) => {
    codes.push(`<code>${body}</code>`);       return '@@CODE' + (codes.length - 1) + '@@';
  });
  // Images are dropped on purpose: the site is self-contained, no assets.
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, label, href) => renderLink(label, href, ctx));
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/@@CODE(\d+)@@/g, (all, n) => codes[Number(n)]);
  return s;
}

function renderLink(label, href, ctx) {
  if (href.charAt(0) === '#') {
    const target = ctx.anchors[href.slice(1)];
    if (!target) return label;
    return '<a href="' + escapeAttr(ctx.relativeTo(target, href.slice(1))) + '">' + label + '</a>';
  }
  if (/^https?:\/\//i.test(href)) {
    return '<a href="' + escapeAttr(href) + '" rel="noopener noreferrer" target="_blank">' + label + '</a>';
  }
  return label;
}

function splitTableRow(line) {
  let s = line.trim();
  if (s.charAt(0) === '|') s = s.slice(1);
  if (s.slice(-1) === '|') s = s.slice(0, -1);
  const cells = [];
  let current = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') { current += '|'; i++; continue; }
    if (c === '|') { cells.push(current.trim()); current = ''; continue; }
    current += c;
  }
  cells.push(current.trim());
  return cells;
}

function renderList(items, ctx) {
  let i = 0;
  function build(indent) {
    const ordered = items[i].ordered;
    const parts = [ordered ? '<ol>' : '<ul>'];
    while (i < items.length && items[i].indent >= indent && items[i].ordered === ordered) {
      if (items[i].indent > indent) {
        const nested = build(items[i].indent);
        parts[parts.length - 1] = parts[parts.length - 1].replace(/<\/li>$/, nested + '</li>');
        continue;
      }
      parts.push('<li>' + inline(items[i].text, ctx) + '</li>');
      i++;
    }
    parts.push(ordered ? '</ol>' : '</ul>');
    return parts.join('');
  }
  let html = '';
  while (i < items.length) html += build(items[i].indent);
  return html;
}

function slugify(text, used) {
  let s = String(text).toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  if (!s) s = 'section';
  let unique = s;
  let n = 2;
  while (used.has(unique)) unique = s + '-' + (n++);
  used.add(unique);
  return unique;
}

// Block-level markdown -> HTML for one README chunk. Headings inside a chunk
// are H3+ (the chunk's own H2 is rendered by the page builder).
function renderMarkdown(text, ctx) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }

    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
      i++;
      out.push('<pre class="code" data-lang="' + escapeAttr(fence[1] || 'text') + '"><code>' + escapeHtml(body.join('\n')) + '</code></pre>');
      continue;
    }

    const anchor = /^<a\s+id="([a-zA-Z0-9_-]+)"><\/a>\s*$/.exec(line.trim());
    if (anchor) { ctx.pendingAnchors.push(anchor[1]); i++; continue; }

    const h = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (h) {
      const level = Math.min(h[1].length, 6);
      const planned = ctx.subQueue && ctx.subQueue.length ? ctx.subQueue.shift() : null;
      const slug = planned ? planned.slug : slugify(h[2], ctx.usedSlugs);
      ctx.registerHeading(level, h[2], slug);
      out.push('<h' + level + ' id="' + slug + '">' + inline(h[2], ctx) + '</h' + level + '>');
      i++;
      continue;
    }

    if (/^\s*\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(lines[i]); i++; }
      const cells = rows.map(splitTableRow);
      const isDelim = (row) => row.length > 0 && row.every((c) => /^:?-{1,}:?$/.test(c.trim()));
      let html = '<div class="tablewrap"><table>';
      if (rows.length >= 2 && isDelim(cells[1])) {
        html += '<thead><tr>' + cells[0].map((c) => '<th>' + inline(c, ctx) + '</th>').join('') + '</tr></thead>';
        html += '<tbody>' + cells.slice(2).map((r) => '<tr>' + r.map((c) => '<td>' + inline(c, ctx) + '</td>').join('') + '</tr>').join('') + '</tbody>';
      } else {
        html += '<tbody>' + cells.map((r) => '<tr>' + r.map((c) => '<td>' + inline(c, ctx) + '</td>').join('') + '</tr>').join('') + '</tbody>';
      }
      out.push(html + '</table></div>');
      continue;
    }

    if (/^(\s*)([-*+]|\d+\.)\s+/.test(line)) {
      const items = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (m) { items.push({ indent: m[1].replace(/\t/g, '  ').length, ordered: /\d/.test(m[2]), text: m[3] }); i++; continue; }
        const cont = /^\s{2,}\S.*$/.exec(lines[i]);
        if (cont && items.length) { items[items.length - 1].text += ' ' + lines[i].trim(); i++; continue; }
        break;
      }
      out.push(renderList(items, ctx));
      continue;
    }

    if (/^>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { body.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push('<blockquote><p>' + inline(body.join(' '), ctx) + '</p></blockquote>');
      continue;
    }

    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    const para = [];
    while (i < lines.length && lines[i].trim() !== ''
      && !/^\s*(#{1,6}\s|```|\||>|<a\s)/.test(lines[i])
      && !/^(\s*)([-*+]|\d+\.)\s+/.test(lines[i])) {
      para.push(lines[i].trim());
      i++;
    }
    if (para.length) {
      const rendered = inline(para.join(' '), ctx);
      if (rendered.trim() !== '') out.push('<p>' + rendered + '</p>');
    }
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// README chunking: H1/H2 boundaries become page sections.
// ---------------------------------------------------------------------------
function splitReadme(md) {
  const at = md.indexOf(README_SPLIT);
  if (at < 0) throw new Error(`gen-docs: README.md has no "${README_SPLIT}" heading; the language split moved`);
  const en = md.slice(0, at);
  const zhLines = md.slice(at).split('\n');
  zhLines.shift();
  return { en, zh: zhLines.join('\n'), cutLine: en.split('\n').length + 1 };
}

function chunkify(md, lang) {
  const lines = md.split('\n').filter((l) => !/^\*\*(English|中文)\*\*/.test(l.trim()));
  const chunks = [];
  let current = { lang, title: null, level: 0, lines: [] };
  let fence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) { fence = !fence; current.lines.push(line); continue; }
    if (!fence) {
      const h = /^(#{1,2})\s+(.*?)\s*$/.exec(line);
      if (h) {
        if (current.title !== null || current.lines.some((x) => x.trim() !== '')) chunks.push(current);
        current = { lang, title: h[2], level: h[1].length, lines: [] };
        continue;
      }
    }
    current.lines.push(line);
  }
  if (current.title !== null || current.lines.some((x) => x.trim() !== '')) chunks.push(current);
  return chunks;
}

// Which page owns a README H2 section. Unmapped sections fall through to the
// guide page so reworded headings lose their placement, never their content.
function pageFor(chunk, isFirst) {
  if (isFirst) return 'index';
  const hay = (chunk.title || '') + ' ' + slugProbe(chunk.title || '');
  if (/install|安装/i.test(hay)) return 'install';
  if (/relay|distributed|分布式/i.test(hay)) return 'relay';
  if (/mcp/i.test(hay)) return 'mcp';
  if (/command|cli|命令/i.test(hay)) return 'cli';
  return 'guide';
}

function slugProbe(text) {
  return String(text).toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, ' ');
}

// Pass 1: assign pages and slugs, and build the global anchor map (including
// explicit <a id> markers, which belong to the page of the NEXT section even
// when the marker sits at the end of the other language half).
function planChunks(chunks) {
  const used = { en: new Set(), zh: new Set() };
  const anchors = {};
  const extraAnchors = {};
  let pending = [];
  let firstSeen = { en: false, zh: false };
  for (const chunk of chunks) {
    const isFirst = !firstSeen[chunk.lang];
    firstSeen[chunk.lang] = true;
    chunk.page = pageFor(chunk, isFirst);
    chunk.isIntro = isFirst;
    chunk.slug = chunk.isIntro ? 'top' : slugify(chunk.title, used[chunk.lang]);
    chunk.subs = [];
    const key = chunk.lang + '/' + chunk.page;
    // Explicit <a id> markers belong to the page of the NEXT section, even when
    // the marker closes the other language half (README's #chinese).
    if (pending.length) {
      extraAnchors[key] = (extraAnchors[key] || []).concat(pending);
      for (const id of pending) anchors[id] = { lang: chunk.lang, page: chunk.page };
      pending = [];
    }
    if (!chunk.isIntro) {
      anchors[chunk.slug] = { lang: chunk.lang, page: chunk.page };
      let fence = false;
      for (const line of chunk.lines) {
        if (/^\s*```/.test(line)) { fence = !fence; continue; }
        if (fence) continue;
        const h = /^(#{3,6})\s+(.*?)\s*$/.exec(line);
        if (h) {
          const slug = slugify(h[2], used[chunk.lang]);
          anchors[slug] = { lang: chunk.lang, page: chunk.page };
          chunk.subs.push({ level: h[1].length, title: h[2], slug });
        }
        const anchor = /^<a\s+id="([a-zA-Z0-9_-]+)"><\/a>\s*$/.exec(line.trim());
        if (anchor) pending.push(anchor[1]);
      }
    } else {
      for (const line of chunk.lines) {
        const anchor = /^<a\s+id="([a-zA-Z0-9_-]+)"><\/a>\s*$/.exec(line.trim());
        if (anchor) pending.push(anchor[1]);
      }
    }
  }
  return { anchors, extraAnchors };
}

// ---------------------------------------------------------------------------
// UI chrome strings. These are the ONLY hand-written words on the site: nav
// labels, table headers, footer. Documentation prose never lives here.
// ---------------------------------------------------------------------------
const I18N = {
  en: {
    langAttr: 'en', switchLabel: 'ZH', skip: 'Skip to content', toc: 'On this page',
    nav: { index: 'Home', install: 'Install', cli: 'CLI', mcp: 'MCP tools', sdk: 'SDK', relay: 'Relay & security', guide: 'Guide' },
    prose: 'From the README', filter: 'Filter',
    mcpRef: 'MCP tools', mcpNote: 'Extracted from the TOOLS array in lib/mcp.js on every build; parameter names, types, defaults and enums come from each tool inputSchema.',
    cliRef: 'CLI reference', cliNote: 'Extracted from bin/openacom.js: the HELP text verbatim, the parseArgs flag table, and the main() dispatch.',
    cliUsage: 'Usage (HELP text, verbatim)', cliSubs: 'Subcommands (main dispatch)', cliFlags: 'Flags (parseArgs)', cliRelay: 'relay / terminal (lib/distributed-cli.js)',
    sdkRef: 'Node SDK', sdkNote: 'The public entry is lib/index.js; implementations live in lib/sdk.js. Signatures and one-line summaries are read from the source; a TODO badge means the export has no source comment to quote.',
    sdkGlance: 'Surface at a glance', sdkErrors: 'Error annotation (lib/sdk.js)',
    installRef: 'Package facts', installNote: 'Read from package.json at build time.',
    relayRef: 'Relay semantics from source', relayCodes: 'Error codes', relaySets: 'Code sets', relayLimits: 'Queue, lease and retention limits', relayIdentity: 'CDP identity checks', relayGroups: 'Agent groups',
    parameter: 'Parameter', type: 'Type', required: 'Required', def: 'Default', allowed: 'Allowed values', description: 'Description', noParams: 'No parameters.',
    flag: 'Flag', value: 'Value', sets: 'Sets', inHelp: 'In HELP', source: 'Source', subcommand: 'Subcommand', handler: 'Handler', usage: 'Usage',
    code: 'Code', http: 'HTTP', meaning: 'Meaning', where: 'Where', limit: 'Constant', envOverride: 'Env override', field: 'Field', pattern: 'Expected pattern', member: 'Member',
    yes: 'yes', no: 'no', none: 'none', todo: 'TODO: no source comment',
    footerGen: 'Generated by tools/gen-docs.js from README.md and the source tree; every API surface on this page is extracted, not retyped.',
    footerSelf: 'Single-file static HTML: no CDN, no web fonts, no runtime dependencies. Opens from disk over file://.',
    sources: 'Sources', version: 'Version',
    titleSuffix: 'OpenAcom',
  },
  zh: {
    langAttr: 'zh-CN', switchLabel: 'EN', skip: '跳到正文', toc: '本页目录',
    nav: { index: '首页', install: '安装', cli: 'CLI', mcp: 'MCP 工具', sdk: 'SDK', relay: 'Relay 与安全', guide: '指南' },
    prose: '来自 README', filter: '过滤',
    mcpRef: 'MCP 工具', mcpNote: '每次构建从 lib/mcp.js 的 TOOLS 数组抽取；参数名、类型、默认值与枚举均来自各工具的 inputSchema。',
    cliRef: 'CLI 参考', cliNote: '从 bin/openacom.js 抽取：HELP 文本原样呈现、parseArgs 旗标表、main() 分发。',
    cliUsage: '用法（HELP 文本，原样）', cliSubs: '子命令（main 分发）', cliFlags: '旗标（parseArgs）', cliRelay: 'relay / terminal（lib/distributed-cli.js）',
    sdkRef: 'Node SDK', sdkNote: '公共入口是 lib/index.js，实现位于 lib/sdk.js。签名与一句话说明读自源码；TODO 标记表示该导出没有可引用的源码注释。',
    sdkGlance: '接口一览', sdkErrors: '错误标注（lib/sdk.js）',
    installRef: '包信息', installNote: '构建时读取 package.json。',
    relayRef: '来自源码的 relay 语义', relayCodes: '错误码', relaySets: '代码集合', relayLimits: '队列、租约与保留期限', relayIdentity: 'CDP 身份核验', relayGroups: 'Agent 群组',
    parameter: '参数', type: '类型', required: '必填', def: '默认值', allowed: '取值', description: '说明', noParams: '无参数。',
    flag: '旗标', value: '取值', sets: '写入', inHelp: 'HELP 中', source: '源码', subcommand: '子命令', handler: '处理函数', usage: '用法',
    code: '错误码', http: 'HTTP', meaning: '含义', where: '位置', limit: '常量', envOverride: '环境变量覆盖', field: '字段', pattern: '期望模式', member: '成员',
    yes: '是', no: '否', none: '无', todo: 'TODO：无源码注释',
    footerGen: '由 tools/gen-docs.js 从 README.md 与源码树生成；本页所有 API 面均为抽取，而非手抄。',
    footerSelf: '单文件静态 HTML：无 CDN、无外部字体、无运行时依赖，可直接以 file:// 打开。',
    sources: '来源', version: '版本',
    titleSuffix: 'OpenAcom',
  },
};

const PAGES = ['index', 'install', 'cli', 'mcp', 'sdk', 'relay', 'guide'];

const CSS = `
:root{--bg:#0d1420;--panel:#16202e;--panel2:#101a28;--line:#22304a;--fg:#b9c3d1;--head:#e8eef7;--accent:#3b82f6;--muted:#7d8ba0;--code:#9fc0e8;--warn:#d29922}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.65 system-ui,"Segoe UI",Roboto,"Helvetica Neue","Microsoft YaHei",sans-serif}
a{color:var(--accent)}
code{background:var(--panel2);border:1px solid var(--line);border-radius:4px;padding:1px 5px;font:12.5px/1.5 ui-monospace,Consolas,"Cascadia Mono",monospace;color:var(--code);overflow-wrap:anywhere}
pre.code{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:12px 14px;overflow-x:auto;max-width:100%;font:12.5px/1.6 ui-monospace,Consolas,"Cascadia Mono",monospace;color:#c6d4e6}
pre.code code{background:none;border:none;padding:0;color:inherit;overflow-wrap:normal;white-space:pre}
.wrap{max-width:1180px;margin:0 auto;padding:0 20px}
.skip{position:absolute;left:-9999px;top:0}
.skip:focus{left:8px;top:8px;background:var(--panel);padding:6px 10px;border-radius:6px;z-index:99}
header.topbar{position:sticky;top:0;z-index:10;background:rgba(13,20,32,.96);border-bottom:1px solid var(--line);backdrop-filter:blur(6px)}
.topbar .wrap{display:flex;align-items:center;gap:18px;min-height:54px;flex-wrap:wrap}
.brand{display:flex;flex-direction:column;text-decoration:none;line-height:1.1;padding:6px 0}
.brand .wordmark{color:#fff;font-weight:800;font-size:19px;letter-spacing:.2px}
.brand .rule{width:34px;height:3px;background:var(--accent);border-radius:2px;margin-top:3px}
.brand .brandtag{color:var(--muted);font-size:10px;letter-spacing:.03em;margin-top:3px;max-width:34ch}
nav.mainnav{display:flex;gap:2px;flex-wrap:wrap;margin-left:auto}
nav.mainnav a{color:var(--muted);text-decoration:none;font-size:13.5px;padding:6px 9px;border-radius:6px}
nav.mainnav a:hover{color:var(--head);background:var(--panel)}
nav.mainnav a.on{color:var(--head);background:var(--panel);box-shadow:inset 0 -2px 0 var(--accent)}
a.langswitch{color:var(--accent);text-decoration:none;font-size:12px;font-weight:700;letter-spacing:.08em;border:1px solid var(--line);border-radius:6px;padding:4px 8px}
a.langswitch:hover{border-color:var(--accent)}
.hero{padding:44px 0 8px}
.hero .wordmark{color:#fff;font-weight:800;font-size:clamp(34px,6vw,52px);letter-spacing:.5px;margin:0}
.hero .rule{width:76px;height:5px;background:var(--accent);border-radius:3px;margin:10px 0 18px}
.hero .tagline{color:#cfd8e6;font-size:clamp(15px,2.4vw,19px);margin:0 0 10px;max-width:46ch}
.hero .lede{max-width:70ch;margin:0 0 18px}
.hero .meta{color:var(--muted);font-size:11px;letter-spacing:.18em;text-transform:uppercase;margin:0 0 6px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:12px;margin:22px 0 8px}
.cards a{display:block;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:13px 15px;text-decoration:none;color:var(--fg)}
.cards a:hover{border-color:var(--accent)}
.cards a b{display:block;color:var(--head);font-size:14.5px;margin-bottom:4px}
.cards a span{font-size:12.5px;color:var(--muted);display:block}
.layout{display:grid;grid-template-columns:225px minmax(0,1fr);gap:30px;padding:26px 0 40px}
details.tocbox{align-self:start;position:sticky;top:66px}
details.tocbox summary{cursor:pointer;color:var(--muted);font-size:13px;padding:6px 0}
.toc-title{color:var(--muted);font-size:11px;letter-spacing:.14em;text-transform:uppercase;margin:0 0 8px}
.toc ul{list-style:none;margin:0;padding:0;border-left:1px solid var(--line)}
.toc li a{display:block;color:var(--muted);text-decoration:none;font-size:13px;padding:4px 10px;border-left:2px solid transparent;margin-left:-1px}
.toc li a:hover{color:var(--head)}
.toc li.l3 a{padding-left:22px;font-size:12.5px}
article{min-width:0}
article h1{color:var(--head);font-size:26px;margin:0 0 6px}
article h1 .rule{display:block;width:52px;height:4px;background:var(--accent);border-radius:2px;margin-top:8px}
article h2{color:var(--head);font-size:20px;margin:38px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line)}
article h3{color:var(--head);font-size:16px;margin:26px 0 8px}
article h4{color:var(--head);font-size:14px;margin:20px 0 6px}
article p{margin:10px 0;max-width:82ch}
article ul,article ol{max-width:82ch;padding-left:22px}
article li{margin:4px 0}
blockquote{border-left:3px solid var(--accent);background:var(--panel);margin:12px 0;padding:8px 14px;border-radius:0 8px 8px 0}
.tablewrap{overflow-x:auto;max-width:100%;margin:12px 0}
table{border-collapse:collapse;width:100%;font-size:13.5px}
th,td{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}
th{background:var(--panel);color:var(--head);font-weight:600;white-space:nowrap}
td code{white-space:nowrap}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:14px 0}
.card h3{margin:0 0 6px}
.card .desc{margin:6px 0 10px}
.badge{display:inline-block;font-size:11px;letter-spacing:.06em;border:1px solid var(--line);border-radius:999px;padding:1px 9px;color:var(--muted);vertical-align:middle;margin-left:8px}
.badge.req{color:var(--accent);border-color:var(--accent)}
.badge.todo{color:var(--warn);border-color:var(--warn)}
.src{color:var(--muted);font-size:11.5px;margin:8px 0 0}
.note{color:var(--muted);font-size:13px;border-left:3px solid var(--line);padding-left:12px;margin:10px 0}
input.filterbox{width:100%;max-width:340px;background:var(--panel2);border:1px solid var(--line);color:var(--head);border-radius:8px;padding:7px 10px;font:13.5px inherit;font-family:inherit;margin:8px 0 4px}
input.filterbox:focus{outline:1px solid var(--accent)}
[hidden]{display:none!important}
footer{border-top:1px solid var(--line);margin-top:30px;padding:18px 0 30px;color:var(--muted);font-size:12.5px}
footer p{margin:4px 0;max-width:90ch}
@media(max-width:900px){
  .layout{grid-template-columns:1fr;gap:10px}
  .brand .brandtag{display:none}
  details.tocbox{position:static;border:1px solid var(--line);border-radius:10px;padding:8px 12px;background:var(--panel)}
  .topbar .wrap{gap:10px}
  nav.mainnav{margin-left:0}
}
`;

function pageFile(lang, page) {
  return (lang === 'zh' ? 'zh/' : '') + page + '.html';
}

function relativeHref(fromLang, toLang, toPage, anchor) {
  const fromDir = fromLang === 'zh' ? 'zh' : '';
  const rel = path.posix.relative(fromDir, pageFile(toLang, toPage)) || 'index.html';
  return rel + (anchor ? '#' + anchor : '');
}

function shell(opts) {
  const t = I18N[opts.lang];
  const nav = PAGES.map((p) => {
    const on = p === opts.page ? ' class="on"' : '';
    return '<a' + on + ' href="' + (p === opts.page ? '#' : relativeHref(opts.lang, opts.lang, p)) + '">' + t.nav[p] + '</a>';
  }).join('');
  const switchHref = relativeHref(opts.lang, opts.lang === 'en' ? 'zh' : 'en', opts.page);
  const toc = opts.toc.length
    ? '<details class="tocbox" open><summary>' + t.toc + '</summary><nav class="toc"><ul>'
      + opts.toc.map((e) => '<li class="l' + e.level + '"><a href="#' + e.slug + '">' + escapeHtml(e.title) + '</a></li>').join('')
      + '</ul></nav></details>'
    : '<div></div>';
  const filter = opts.filter
    ? '<input class="filterbox" id="oa-filter" type="search" placeholder="' + escapeAttr(t.filter) + '" aria-label="' + escapeAttr(t.filter) + '">'
    : '';
  return '<!doctype html>\n'
    + '<html lang="' + t.langAttr + '">\n<head>\n<meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + '<title>' + escapeHtml(opts.title) + ' · ' + t.titleSuffix + '</title>\n'
    + '<meta name="description" content="' + escapeAttr(opts.description) + '">\n'
    + '<style>' + CSS + '</style>\n</head>\n<body>\n'
    + '<a class="skip" href="#main">' + t.skip + '</a>\n'
    + '<header class="topbar"><div class="wrap">'
    + '<a class="brand" href="' + (opts.page === 'index' ? '#' : relativeHref(opts.lang, opts.lang, 'index')) + '"><span class="wordmark">OpenAcom</span><span class="rule"></span><span class="brandtag">' + escapeHtml(opts.tagline) + '</span></a>'
    + '<nav class="mainnav" aria-label="site">' + nav + '</nav>'
    + '<a class="langswitch" href="' + switchHref + '">' + t.switchLabel + '</a>'
    + '</div></header>\n'
    + (opts.hero || '')
    + '<div class="wrap"><div class="layout">'
    + toc
    + '<main id="main"><article>'
    + filter
    + opts.body
    + '</article></main>'
    + '</div></div>\n'
    + '<footer><div class="wrap">'
    + '<p>' + t.titleSuffix + ' ' + t.version + ' ' + escapeHtml(opts.version) + ' · ' + t.footerGen + '</p>'
    + '<p>' + t.footerSelf + '</p>'
    + '<p>' + t.sources + ': ' + opts.sources.map((s) => '<code>' + escapeHtml(s) + '</code>').join(' ') + '</p>'
    + '</div></footer>\n'
    + (opts.filter ? '<script>\n(function(){var input=document.getElementById("oa-filter");if(!input)return;input.addEventListener("input",function(){var q=input.value.trim().toLowerCase();document.querySelectorAll("[data-filter-item]").forEach(function(el){el.hidden=q!==""&&el.getAttribute("data-filter-item").toLowerCase().indexOf(q)===-1;});});})();\n</script>\n' : '')
    + '</body>\n</html>\n';
}

// ---------------------------------------------------------------------------
// Generated reference blocks. Every string of documentation content below comes
// from the model; the only literals are markup and i18n chrome keys.
// ---------------------------------------------------------------------------
function refHead(toc, level, slug, title) {
  toc.push({ level, slug, title });
  return '<h' + level + ' id="' + slug + '">' + escapeHtml(title) + '</h' + level + '>';
}

function buildMcpRef(model, t) {
  const toc = [];
  let html = refHead(toc, 2, 'mcp-tools', t.mcpRef) + '<p class="note">' + escapeHtml(t.mcpNote) + '</p>';
  for (const tool of model.tools) {
    html += '<section class="card" id="tool-' + escapeAttr(tool.name) + '" data-filter-item="' + escapeAttr(tool.name) + '">';
    html += '<h3><code>' + escapeHtml(tool.name) + '</code><span class="badge">MCP</span></h3>';
    html += '<p class="desc">' + escapeHtml(tool.description) + '</p>';
    if (tool.params.length) {
      html += '<div class="tablewrap"><table><thead><tr>'
        + [t.parameter, t.type, t.required, t.def, t.allowed, t.description].map((h) => '<th>' + escapeHtml(h) + '</th>').join('')
        + '</tr></thead><tbody>';
      for (const p of tool.params) {
        html += '<tr><td><code>' + escapeHtml(p.name) + '</code></td>'
          + '<td>' + escapeHtml(p.type) + '</td>'
          + '<td>' + (p.required ? '<span class="badge req">' + t.yes + '</span>' : t.no) + '</td>'
          + '<td>' + (p.hasDefault ? '<code>' + escapeHtml(JSON.stringify(p.def)) + '</code>' : '-') + '</td>'
          + '<td>' + (p.enum ? p.enum.map((v) => '<code>' + escapeHtml(JSON.stringify(v)) + '</code>').join(' ') : '-') + '</td>'
          + '<td>' + (p.description ? escapeHtml(p.description) : '') + '</td></tr>';
      }
      html += '</tbody></table></div>';
    } else {
      html += '<p class="note">' + escapeHtml(t.noParams) + '</p>';
    }
    html += '<p class="src">lib/mcp.js TOOLS[' + tool.index + ']</p></section>';
  }
  return { html, toc };
}

function buildCliRef(model, t) {
  const toc = [];
  const cli = model.cli;
  let html = refHead(toc, 2, 'cli-reference', t.cliRef) + '<p class="note">' + escapeHtml(t.cliNote) + '</p>';
  html += refHead(toc, 3, 'cli-usage', t.cliUsage) + '<pre class="code" data-lang="text"><code>' + escapeHtml(cli.help.text) + '</code></pre>';
  html += refHead(toc, 3, 'cli-subcommands', t.cliSubs)
    + '<div class="tablewrap"><table><thead><tr><th>' + t.subcommand + '</th><th>' + t.handler + '</th><th>' + t.usage + '</th><th>' + t.source + '</th></tr></thead><tbody>';
  for (const sub of cli.subs) {
    const usage = cli.usage.filter((u) => u.cmd === sub.name).map((u) => u.lines.join(' ')).join(' ');
    html += '<tr><td><code>' + escapeHtml(sub.name) + '</code></td><td><code>' + escapeHtml(sub.handler || '-') + '</code></td><td><code>' + escapeHtml(usage || '-') + '</code></td><td><code>bin/openacom.js:' + sub.line + '</code></td></tr>';
  }
  html += '</tbody></table></div>';
  html += refHead(toc, 3, 'cli-flags', t.cliFlags)
    + '<div class="tablewrap"><table><thead><tr><th>' + t.flag + '</th><th>' + t.value + '</th><th>' + t.sets + '</th><th>' + t.inHelp + '</th><th>' + t.source + '</th></tr></thead><tbody>';
  for (const row of cli.parseArgs) {
    html += '<tr data-filter-item="' + escapeAttr(row.flags.join(' ')) + '"><td>' + row.flags.map((f) => '<code>' + escapeHtml(f) + '</code>').join(' ') + '</td>'
      + '<td>' + escapeHtml(row.kind) + '</td><td><code>flags.' + escapeHtml(row.dest || '_') + '</code></td>'
      + '<td>' + (cli.helpFlags.includes(row.flags[0]) ? t.yes : t.no) + '</td>'
      + '<td><code>bin/openacom.js:' + row.line + '</code></td></tr>';
  }
  html += '</tbody></table></div>';
  const relayHandled = [].concat(...Object.values(model.relayCli.options));
  const others = cli.helpFlags.filter((f) => !cli.parseArgs.some((r) => r.flags.includes(f)));
  if (others.length) {
    html += '<div class="tablewrap"><table><thead><tr><th>' + t.flag + '</th><th>' + t.handler + '</th></tr></thead><tbody>';
    for (const f of others) {
      const where = relayHandled.includes(f.replace(/^--/, '')) ? 'lib/distributed-cli.js'
        : model.relayCli.terminalFlags.includes(f.replace(/^--/, '')) ? 'lib/distributed-cli.js (terminal)' : '-';
      html += '<tr><td><code>' + escapeHtml(f) + '</code></td><td><code>' + escapeHtml(where) + '</code></td></tr>';
    }
    html += '</tbody></table></div>';
  }
  html += refHead(toc, 3, 'cli-relay-terminal', t.cliRelay)
    + '<pre class="code" data-lang="text"><code>' + escapeHtml(model.relayCli.help.text) + '</code></pre>'
    + '<div class="tablewrap"><table><thead><tr><th>' + t.subcommand + '</th><th>' + t.allowed + '</th></tr></thead><tbody>';
  for (const [sub, flags] of Object.entries(model.relayCli.options)) {
    html += '<tr><td><code>relay ' + escapeHtml(sub) + '</code></td><td>' + flags.map((f) => '<code>--' + escapeHtml(f) + '</code>').join(' ') + '</td></tr>';
  }
  html += '<tr><td><code>relay token</code></td><td>-</td></tr>';
  html += '<tr><td><code>terminal</code></td><td>' + model.relayCli.terminalFlags.map((f) => '<code>--' + escapeHtml(f) + '</code>').join(' ') + ' <code>--</code></td></tr>';
  html += '</tbody></table></div>';
  return { html, toc };
}

function buildSdkRef(model, t) {
  const toc = [];
  const sdk = model.sdk;
  let html = refHead(toc, 2, 'sdk-surface', t.sdkRef) + '<p class="note">' + escapeHtml(t.sdkNote) + '</p>';
  let glance = "const relay = require('openacom');   // lib/index.js\n";
  for (const e of sdk.exports) {
    if (e.kind === 'function') glance += 'relay.' + e.name + '(' + e.params + ')\n';
    else glance += 'relay.' + e.name + '  { ' + e.members.map((m) => m.name).join(', ') + ' }\n';
  }
  html += refHead(toc, 3, 'sdk-glance', t.sdkGlance) + '<pre class="code" data-lang="js"><code>' + escapeHtml(glance) + '</code></pre>';
  for (const e of sdk.exports) {
    html += '<section class="card" id="sdk-' + escapeAttr(e.name) + '" data-filter-item="' + escapeAttr(e.name) + '">';
    html += '<h3><code>relay.' + escapeHtml(e.name) + (e.kind === 'function' ? '(' + escapeHtml(e.params) + ')' : '') + '</code>'
      + '<span class="badge">' + escapeHtml(e.kind) + '</span>'
      + (e.kind === 'function' && !e.summary ? '<span class="badge todo">' + escapeHtml(t.todo) + '</span>' : '') + '</h3>';
    if (e.summary) html += '<p class="desc">' + escapeHtml(e.summary) + '</p>';
    if (e.members.length) {
      html += '<div class="tablewrap"><table><thead><tr><th>' + t.member + '</th><th>' + t.type + '</th><th>' + t.description + '</th><th>' + t.source + '</th></tr></thead><tbody>';
      for (const m of e.members) {
        html += '<tr><td><code>' + escapeHtml(m.name) + (m.kind === 'function' ? '(' + escapeHtml(m.params) + ')' : '') + '</code></td>'
          + '<td>' + escapeHtml(m.kind) + '</td>'
          + '<td>' + (m.summary ? escapeHtml(m.summary) : (m.kind === 'function' ? '<span class="badge todo">' + escapeHtml(t.todo) + '</span>' : '')) + '</td>'
          + '<td><code>' + escapeHtml(m.source || '-') + '</code></td></tr>';
      }
      html += '</tbody></table></div>';
    }
    html += '<p class="src">' + escapeHtml(e.source || 'lib/index.js') + '</p></section>';
  }
  if (sdk.derived.length || sdk.certain.length) {
    html += refHead(toc, 3, 'sdk-errors', t.sdkErrors);
    if (sdk.derived.length) {
      html += '<div class="tablewrap"><table><thead><tr><th>' + t.code + '</th><th>' + t.meaning + '</th></tr></thead><tbody>';
      for (const d of sdk.derived) html += '<tr><td><code>' + escapeHtml(d.code) + '</code></td><td><code>' + escapeHtml(d.pattern) + '</code></td></tr>';
      html += '</tbody></table></div>';
    }
    if (sdk.certain.length) {
      html += '<p class="note">' + sdk.certain.map((c) => '<code>' + escapeHtml(c) + '</code>').join(' ') + '</p>';
    }
  }
  return { html, toc };
}

function buildRelayRef(model, t) {
  const toc = [];
  let html = refHead(toc, 2, 'relay-source', t.relayRef);
  html += refHead(toc, 3, 'relay-error-codes', t.relayCodes)
    + '<div class="tablewrap"><table><thead><tr><th>' + t.code + '</th><th>' + t.http + '</th><th>' + t.meaning + '</th><th>' + t.where + '</th></tr></thead><tbody>';
  for (const row of model.codes) {
    html += '<tr data-filter-item="' + escapeAttr(row.code) + '"><td><code>' + escapeHtml(row.code) + '</code></td>'
      + '<td>' + escapeHtml(row.status || '-') + '</td>'
      + '<td>' + escapeHtml(row.meaning || '-') + '</td>'
      + '<td>' + row.sites.map((s) => '<code>' + escapeHtml(s) + '</code>').join(' ') + '</td></tr>';
  }
  html += '</tbody></table></div>';
  html += refHead(toc, 3, 'relay-code-sets', t.relaySets);
  for (const set of model.sets) {
    html += '<div class="card"><h3><code>' + escapeHtml(set.name) + '</code></h3>'
      + (set.summary ? '<p class="desc">' + escapeHtml(set.summary) + '</p>' : '')
      + '<p>' + set.values.map((v) => '<code>' + escapeHtml(String(v)) + '</code>').join(' ') + '</p>'
      + '<p class="src">' + escapeHtml(set.file + ':' + set.line) + '</p></div>';
  }
  html += refHead(toc, 3, 'relay-limits', t.relayLimits)
    + '<div class="tablewrap"><table><thead><tr><th>' + t.limit + '</th><th>' + t.value + '</th><th>' + t.envOverride + '</th><th>' + t.where + '</th></tr></thead><tbody>';
  for (const row of model.limits) {
    html += '<tr><td><code>' + escapeHtml(row.name) + '</code></td><td><code>' + escapeHtml(String(row.value)) + '</code></td>'
      + '<td>' + (row.env ? '<code>' + escapeHtml(row.env) + '</code>' : '-') + '</td>'
      + '<td><code>' + escapeHtml(row.file + ':' + row.line) + '</code></td></tr>';
  }
  html += '</tbody></table></div>';
  html += refHead(toc, 3, 'relay-identity', t.relayIdentity)
    + '<div class="tablewrap"><table><thead><tr><th>' + t.field + '</th><th>' + t.pattern + '</th></tr></thead><tbody>';
  for (const f of model.identity.fields) {
    html += '<tr><td><code>' + escapeHtml(f.name) + '</code></td><td><code>' + escapeHtml(f.pattern) + '</code></td></tr>';
  }
  html += '</tbody></table></div>'
    + '<p class="note">' + model.identity.consentEnv.map((c) => '<code>' + escapeHtml(c) + '</code>').join(' ') + ' <code>lib/desktop-delivery.js:' + model.identity.line + '</code></p>';
  html += refHead(toc, 3, 'relay-groups', t.relayGroups)
    + '<div class="card"><p><code>' + escapeHtml(model.groups.fileExpr || '-') + '</code></p>'
    + '<p>' + model.groups.env.map((e) => '<code>' + escapeHtml(e) + '</code>').join(' ') + '</p>'
    + '<p class="src">lib/groups.js</p></div>';
  return { html, toc };
}

function buildInstallRef(model, t) {
  const toc = [];
  const pkg = model.pkg;
  let html = refHead(toc, 2, 'install-facts', t.installRef) + '<p class="note">' + escapeHtml(t.installNote) + '</p>';
  const rows = [
    ['name', pkg.name], ['version', pkg.version], ['engines.node', pkg.engines && pkg.engines.node],
    ['bin', pkg.bin && Object.keys(pkg.bin).map((k) => k).join(', ')], ['main', pkg.main],
    ['repository', pkg.repository && pkg.repository.url], ['license', pkg.license],
  ];
  html += '<div class="tablewrap"><table><thead><tr><th>' + t.limit + '</th><th>' + t.value + '</th></tr></thead><tbody>';
  for (const [k, v] of rows) html += '<tr><td><code>' + escapeHtml(k) + '</code></td><td><code>' + escapeHtml(String(v)) + '</code></td></tr>';
  html += '</tbody></table></div>';
  return { html, toc };
}

// The English tagline is brand chrome pinned to the banner artwork; the Chinese
// one is parsed from the README intro.
const TAGLINE_EN = 'Opensource, distributed, and safe agent communication.';

function introBits(chunk) {
  const lines = [];
  let tagline = null;
  let lede = null;
  let i = 0;
  while (i < chunk.lines.length) {
    const s = chunk.lines[i].trim();
    if (tagline === null && /^\*\*[^*]+\*\*$/.test(s)) { tagline = s.slice(2, -2); i++; continue; }
    if (tagline !== null && lede === null && s !== '' && !/^[#!]/.test(s)) {
      const para = [s];
      i++;
      while (i < chunk.lines.length && chunk.lines[i].trim() !== '' && !/^[#|!]/.test(chunk.lines[i].trim())) { para.push(chunk.lines[i].trim()); i++; }
      lede = para.join(' ').replace(/\*\*/g, '');
      continue;
    }
    lines.push(chunk.lines[i]);
    i++;
  }
  return { tagline, lede, lines };
}

function collect(root) {
  const src = {};
  for (const rel of REQUIRED_SOURCES) src[rel] = readSource(root, rel);
  const pkg = JSON.parse(src['package.json']);
  const tools = extractTools(src['lib/mcp.js']);
  const help = extractHelp(src['bin/openacom.js'], 'bin/openacom.js');
  const cli = {
    help,
    usage: extractUsageLines(help.text),
    helpFlags: extractFlags(help.text),
    parseArgs: extractParseArgs(src['bin/openacom.js'], 'bin/openacom.js'),
    subs: extractSubcommands(src['bin/openacom.js']),
  };
  const relayCli = extractRelayCli(src['lib/distributed-cli.js']);
  const sdk = extractSdk(root);
  const codes = extractErrorCodes(root, ['lib/distributed.js', 'lib/desktop-delivery.js', 'lib/groups.js', 'lib/delivery.js', 'lib/sdk.js']);
  const sets = [].concat(
    extractCodeSets(root, 'lib/distributed.js', ['DEFERRABLE_CODES', 'SECURITY_ALERT_KINDS']),
    extractCodeSets(root, 'lib/desktop-delivery.js', ['PROBE_CODES']),
  );
  const limits = extractLimits(root, 'lib/distributed.js');
  const identity = extractIdentity(root);
  const groups = extractGroups(root);

  const halves = splitReadme(src['README.md']);
  const chunks = chunkify(halves.en, 'en').concat(chunkify(halves.zh, 'zh'));
  const plan = planChunks(chunks);

  const intro = {};
  for (const lang of ['en', 'zh']) {
    const chunk = chunks.find((c) => c.lang === lang && c.page === 'index');
    if (!chunk) throw new Error(`gen-docs: README ${lang} half has no intro section`);
    intro[lang] = introBits(chunk);
    chunk.filtered = intro[lang].lines;
  }
  for (const chunk of chunks) if (!chunk.filtered) chunk.filtered = chunk.lines;

  const teasers = {};
  for (const lang of ['en', 'zh']) {
    teasers[lang] = {};
    for (const page of PAGES) {
      let text = '';
      for (const c of chunks.filter((x) => x.lang === lang && x.page === page)) {
        const L = c.filtered;
        for (let i = 0; i < L.length && !text; i++) {
          const s = L[i].trim();
          if (s === '' || /^[#|!>]/.test(s) || /^\s*([-*+]|\d+\.)\s/.test(s)) continue;
          const para = [s];
          for (let j = i + 1; j < L.length; j++) {
            const t2 = L[j].trim();
            if (t2 === '' || /^[#|!>]/.test(t2) || /^\s*([-*+]|\d+\.)\s/.test(t2)) break;
            para.push(t2);
          }
          text = para.join(' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
        }
        if (text) break;
      }
      teasers[lang][page] = text ? firstSentence(text.replace(/\*\*/g, ''), 150) : '';
    }
  }
  // The Chinese half keeps its CLI/MCP/install prose inside the intro block, so
  // route those three card teasers from the intro's own lines by their lead-in.
  const ZH_HINTS = { cli: /^-\s*`openacom list/, mcp: /MCP 工具一览/, install: /^安装：/ };
  const zhIntro = chunks.find((c) => c.lang === 'zh' && c.page === 'index');
  if (zhIntro) {
    for (const [page, hint] of Object.entries(ZH_HINTS)) {
      if (teasers.zh[page]) continue;
      const at = zhIntro.filtered.findIndex((l) => hint.test(l.trim()));
      if (at < 0) continue;
      const para = [zhIntro.filtered[at].trim()];
      for (let j = at + 1; j < zhIntro.filtered.length; j++) {
        const s = zhIntro.filtered[j].trim();
        if (s === '' || /^[-#|!>]/.test(s)) break;
        para.push(s);
      }
      teasers.zh[page] = firstSentence(para.join(' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*/g, ''), 150);
    }
  }

  return { pkg, tools, cli, relayCli, sdk, codes, sets, limits, identity, groups, chunks, anchors: plan.anchors, extraAnchors: plan.extraAnchors, intro, teasers };
}

function buildHero(model, lang, t) {
  const tagline = lang === 'en' ? TAGLINE_EN : model.intro.zh.tagline;
  const lede = model.intro[lang].lede || '';
  const agents = Object.keys(model.sdk.runtime.adapters || {}).map((a) => a.toUpperCase()).join(' · ');
  const verbs = model.cli.subs.map((s) => s.name.toUpperCase()).join(' · ');
  const cards = PAGES.filter((p) => p !== 'index').map((p) => {
    const fallback = p === 'sdk' ? firstSentence(model.sdk.header.split('\n').map((l) => l.replace(/^\/\/\s?/, '')).join(' '), 150) : '';
    const teaser = model.teasers[lang][p] || fallback;
    const ctx = {
      anchors: {}, usedSlugs: new Set(), pendingAnchors: [], subQueue: [], headings: [],
      registerHeading() {}, relativeTo() { return '#'; },
    };
    return '<a href="' + relativeHref(lang, lang, p) + '"><b>' + escapeHtml(t.nav[p]) + '</b>' + (teaser ? '<span>' + inline(teaser, ctx) + '</span>' : '') + '</a>';
  }).join('');
  return '<div class="wrap"><div class="hero">'
    + '<p class="wordmark">OpenAcom</p><div class="rule"></div>'
    + '<p class="tagline">' + escapeHtml(tagline) + '</p>'
    + (lede ? '<p class="lede">' + escapeHtml(lede) + '</p>' : '')
    + '<p class="meta">' + escapeHtml(agents) + '</p>'
    + '<p class="meta">' + escapeHtml(verbs) + '</p>'
    + '<div class="cards">' + cards + '</div>'
    + '</div></div>\n';
}

const REF_FIRST = { index: false, install: true, cli: true, mcp: true, sdk: true, relay: false, guide: false };
const FILTERED = { mcp: true, cli: true, sdk: true, relay: true };

function buildPage(model, lang, page) {
  const t = I18N[lang];
  const chunks = model.chunks.filter((c) => c.lang === lang && c.page === page);
  const usedSlugs = new Set();
  let prose = '';
  const proseToc = [];
  for (const chunk of chunks) {
    const ctx = {
      lang,
      page,
      anchors: model.anchors,
      usedSlugs,
      pendingAnchors: [],
      subQueue: chunk.subs.slice(),
      headings: [],
      registerHeading(level, title, slug) { ctx.headings.push({ level, title, slug }); },
      relativeTo(target, id) {
        if (target.lang === lang && target.page === page) return '#' + id;
        return relativeHref(lang, target.lang, target.page, id);
      },
    };
    const rendered = renderMarkdown(chunk.filtered.join('\n'), ctx);
    if (chunk.isIntro) {
      prose += rendered;
    } else {
      prose += '<h2 id="' + chunk.slug + '">' + inline(chunk.title, ctx) + '</h2>' + rendered;
      proseToc.push({ level: 2, slug: chunk.slug, title: chunk.title });
    }
    for (const h of ctx.headings) proseToc.push({ level: Math.min(h.level, 4), slug: h.slug, title: h.title });
  }

  const builders = { mcp: buildMcpRef, cli: buildCliRef, sdk: buildSdkRef, relay: buildRelayRef, install: buildInstallRef };
  let refHtml = '';
  let refToc = [];
  if (builders[page]) {
    const ref = builders[page](model, t);
    refHtml = ref.html;
    refToc = ref.toc;
  }

  const extra = model.extraAnchors[lang + '/' + page] || [];
  let body = extra.map((id) => '<span id="' + escapeAttr(id) + '"></span>').join('');
  let toc = [];
  if (page === 'index') body += buildHero(model, lang, t);
  else body += '<h1>' + escapeHtml(t.nav[page]) + '<span class="rule"></span></h1>';
  if (REF_FIRST[page]) {
    body += refHtml + prose;
    toc = refToc.concat(proseToc);
  } else {
    body += prose + refHtml;
    toc = proseToc.concat(refToc);
  }
  if (proseToc.length) toc = toc.concat();
  const tagline = lang === 'en' ? TAGLINE_EN : model.intro.zh.tagline;
  const html = shell({
    lang,
    page,
    title: t.nav[page],
    description: t.nav[page] + ' - ' + tagline,
    version: model.pkg.version,
    sources: REQUIRED_SOURCES,
    tagline,
    toc,
    body,
    filter: !!FILTERED[page],
  });
  return html;
}

function buildSite(root, outDir) {
  const model = collect(root);
  const pages = [];
  for (const lang of ['en', 'zh']) {
    for (const page of PAGES) {
      const rel = pageFile(lang, page);
      const file = path.join(outDir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buildPage(model, lang, page));
      pages.push({ lang, page, file: rel });
    }
  }
  return { pages, todos: model.sdk.todos, model };
}

function main() {
  const outDir = path.join(ROOT, 'docs');
  const result = buildSite(ROOT, outDir);
  console.log(`gen-docs: wrote ${result.pages.length} pages to ${path.relative(process.cwd(), outDir) || outDir}`);
  for (const p of result.pages) console.log(`  ${p.lang === 'zh' ? 'zh' : 'en'}  ${p.file}`);
  if (result.todos.length) {
    console.log('gen-docs: SDK exports without a source comment (rendered as TODO):');
    for (const name of result.todos) console.log('  - ' + name);
  } else {
    console.log('gen-docs: every SDK export carries a source comment');
  }
}

module.exports = {
  buildSite,
  collect,
  extractTools,
  extractHelp,
  extractFlags,
  extractParseArgs,
  extractSubcommands,
  extractSdk,
  extractErrorCodes,
  splitReadme,
  REQUIRED_SOURCES,
  PAGES,
  pageFile,
  ROOT,
};

if (require.main === module) main();
