'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

// The byte gate cannot see this defect: README once lost a path separator to an
// interpreted escape, so a documented command read `tools` + newline +
// `elay-remote-up.ps1`. The surviving text names no file, and under core.autocrlf
// the leftover CR is indistinguishable from a line ending - only a content gate
// that resolves what the document asserts can pin it.
const PATH_CLAIM = /(?:^|[^A-Za-z0-9_./\\-])(tools|lib|bin)([/\\])([A-Za-z0-9._/\\-]+)/g;
const TOOL_MENTION = /`([a-z][a-z0-9_]{3,})`/g;
const TOOL_CONTEXT = /mcp|tool|工具/i;
const NAME_DECL = /\bname:\s*'([a-z_]+)'/g;
// Inside a command block a line may not end on a bare directory name or on a
// trailing separator; in prose those same letters are ordinary English.
const DANGLING_DIR = /(?:^|[^A-Za-z0-9_])(?:tools|lib|bin)[/\\]?[ \t]*$/;

function pathClaims(text) {
  const claims = [];
  for (const match of text.matchAll(PATH_CLAIM)) {
    // Sentence punctuation ends the claim, but an interior dot is part of it.
    claims.push(`${match[1]}/${match[3].replace(/[.,;:)]+$/, '')}`);
  }
  return claims;
}

// Case-sensitive on every platform: a wrong-cased path resolves on NTFS and then
// breaks the reader on Linux, so compare against the real directory listing.
function resolvable(claim) {
  let directory = ROOT;
  const parts = claim.split(/[\\/]/).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    if (!fs.existsSync(directory)) return false;
    if (!fs.readdirSync(directory).includes(part)) return false;
    if (index === parts.length - 1) return fs.statSync(path.join(directory, part)).isFile();
    directory = path.join(directory, part);
  }
  return false;
}

function codeBlockLines(text) {
  const lines = [];
  let open = false;
  text.split(/\r?\n/).forEach((line, index) => {
    if (/^```/.test(line)) { open = !open; return; }
    if (open && line.trim()) lines.push({ number: index + 1, text: line });
  });
  return { lines, balanced: !open };
}

function severedPaths(text) {
  const { lines, balanced } = codeBlockLines(text);
  assert.equal(balanced, true, 'README code fences are unbalanced, so the command-block scan is unreliable.');
  return lines.filter((entry) => DANGLING_DIR.test(entry.text))
    .map((entry) => `README.md:${entry.number} command line ends on a severed path: ${JSON.stringify(entry.text.slice(-40))}`);
}

function toolsArrayLiteral(source) {
  // Brace-match the array instead of hunting for `];`, so a reformatted file
  // cannot silently widen the region into the MCP serverInfo name.
  const opening = source.indexOf('const TOOLS = [');
  assert.notEqual(opening, -1, 'lib/mcp.js no longer declares `const TOOLS = [`');
  let depth = 0;
  let quote = null;
  for (let index = opening + 'const TOOLS = '.length; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
    } else if ("'\"`".includes(character)) quote = character;
    else if ('[{('.includes(character)) depth += 1;
    else if (']})'.includes(character)) {
      depth -= 1;
      if (depth === 0) return source.slice(opening, index + 1);
    }
  }
  assert.fail('The TOOLS array in lib/mcp.js is not balanced.');
}

function toolNames(mcpSource) {
  return [...toolsArrayLiteral(mcpSource).matchAll(NAME_DECL)].map((match) => match[1]);
}

function toolSource(corpus) {
  const declared = toolNames(corpus.get('lib/mcp.js'));
  const readmeText = corpus.get('README.md');
  const mentioned = new Set([...readmeText.matchAll(TOOL_MENTION)].map((match) => match[1]));
  const otherCode = [...corpus.entries()].filter(([name]) => name !== 'README.md').map(([, text]) => text).join('\n');
  const toolContext = new Set();
  for (const line of readmeText.split(/\r?\n/)) {
    if (TOOL_CONTEXT.test(line)) for (const match of line.matchAll(TOOL_MENTION)) toolContext.add(match[1]);
  }
  // Names that share a declared tool's leading segment claim membership in that
  // family, so a near-miss such as relay_state reads as a broken tool name even
  // where the sentence never says the word tool.
  const family = new Set(declared.filter((name) => name.includes('_')).map((name) => name.split('_')[0]));
  // Whole-word, so a truncated near-miss is not "owned" by being a substring of
  // the real identifier.
  const codeOwns = (name) => new RegExp(`\\b${name}\\b`).test(otherCode);
  return {
    declared,
    // Every tool the server declares has to be documented somewhere; a tool named
    // in a heading without backticks still counts as documented.
    undocumented: declared.filter((name) => !new RegExp(`\\b${name}\\b`).test(readmeText)),
    misnamed: [...mentioned].filter((name) => name.includes('_') && family.has(name.split('_')[0])
      && !declared.includes(name) && !codeOwns(name)),
    // A name presented beside MCP tool talk must be real; scoping to those lines
    // keeps identifiers this repo deliberately does not own (another product's
    // database table named in an explanation) out of the gate.
    invented: [...toolContext].filter((name) => !declared.includes(name) && !codeOwns(name)),
  };
}

function walk(directory, found = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) walk(relative, found);
    else if (/\.(?:js|json|html|md|ps1|py|ts)$/.test(entry.name)) found.push(relative);
  }
  return found;
}

test('README path claims and its MCP tool list resolve against the repository', async () => {
  // Self-check: feed each gate the exact corruption it exists to catch, so a
  // silently broken pattern fails this run instead of passing every future one.
  assert.deepEqual(pathClaims('`tools/relay-remote-up.ps1`, `bin/openacom.js` and lib/web.'), [
    'tools/relay-remote-up.ps1', 'bin/openacom.js', 'lib/web',
  ]);
  assert.deepEqual(pathClaims('see tools/dead-script.ps1 for it'), ['tools/dead-script.ps1']);
  assert.equal(resolvable('tools/dead-script.ps1'), false);
  assert.equal(resolvable('bin/openacom.js'), true);
  assert.equal(resolvable('Bin/openacom.js'), false, 'wrong case must not pass on a case-insensitive filesystem');
  assert.deepEqual(severedPaths('```powershell\nnode tools\n```\n'), [
    'README.md:2 command line ends on a severed path: "node tools"',
  ]);
  assert.deepEqual(severedPaths('```sh\nnode tools/\n```\n'), [
    'README.md:2 command line ends on a severed path: "node tools/"',
  ]);
  assert.deepEqual(severedPaths('prose that happens to end on the word tools\n'), []);
  const historical = '```powershell\npowershell -File tools\nelay-remote-up.ps1 -SshHost x\n```\n';
  assert.deepEqual(pathClaims(historical), [], 'the historical defect names no file: existence checks alone stay blind');
  assert.equal(severedPaths(historical).length, 1, 'the historical defect must be pinned by the command-block rule');
  const drift = toolSource(new Map([
    ['README.md', '`relay_send` and `list_sessions` are MCP tools\n`relay_status` is a MCP tool too\n`session_input` is another product queue, mentioned in passing\n`list_sessionz` appears on a line of plain prose only\n`send_receipt` names a queue kind that the code owns\n`list_session` is a truncated near-miss\nplain prose names ack_message without backticks\n'],
    ['lib/mcp.js', "const TOOLS = [\n  { name: 'list_sessions' },\n  { name: 'read_session' },\n  { name: 'ack_message' },\n];\nserverInfo: { name: 'openacom' }\n"],
    ['lib/other.js', 'const relay_send = 1;\nconst send_receipt = 2;\nconst list_sessions = 3;\n'],
  ]));
  assert.deepEqual(drift.declared, ['list_sessions', 'read_session', 'ack_message'], 'serverInfo must not be read as a tool');
  assert.deepEqual(drift.undocumented, ['read_session'], 'a declared tool absent from README is drift, and a backtick-free mention still counts');
  assert.deepEqual(drift.invented, ['relay_status'],
    'an MCP-tool-shaped name with no code behind it is drift, while a code-owned foreign name is not');
  assert.deepEqual(drift.misnamed, ['list_sessionz', 'list_session'],
    'a tool-prefixed name is drift even outside MCP wording, unless the code owns it as a whole word');
  assert.deepEqual(toolNames("const TOOLS = [{ name: 'a_tool' }, { name: 'b_tool' }];\nconst MORE = [{ name: 'c_tool' }];\n"),
    ['a_tool', 'b_tool'], 'tool extraction must stop at the TOOLS array, not the whole file');

  const readme = read('README.md');
  const corpus = new Map(walk('lib').concat(walk('bin'), walk('tools'), ['README.md', 'package.json']).map((f) => [f, read(f)]));
  const claims = pathClaims(readme);
  assert.ok(claims.length >= 3, `README path claims look unextracted: ${JSON.stringify(claims)}`);
  for (const prefix of ['tools/', 'bin/']) {
    assert.ok(claims.some((claim) => claim.startsWith(prefix)), `README no longer yields any ${prefix} claim; the extraction pattern is stale`);
  }
  const checked = toolSource(corpus);
  assert.ok(checked.declared.length >= 5, `implausible MCP tool count from lib/mcp.js: ${checked.declared.length}`);

  const missing = [...new Set(claims.filter((claim) => !resolvable(claim)))];
  const severed = severedPaths(readme);
  assert.equal(
    missing.length + severed.length + checked.undocumented.length + checked.misnamed.length + checked.invented.length,
    0,
    [
      `checked ${new Set(claims).size} path claim(s): ${[...new Set(claims)].join(', ')}`,
      `${checked.declared.length} declared MCP tool(s): ${checked.declared.join(', ')}`,
      missing.length ? `path(s) that do not exist: ${missing.join(', ')}` : '',
      severed.length ? `severed path(s):\n${severed.join('\n')}` : '',
      checked.undocumented.length ? `tool(s) missing from README: ${checked.undocumented.join(', ')}` : '',
      checked.misnamed.length ? `tool-family name(s) that lib/mcp.js does not declare: ${checked.misnamed.join(', ')}` : '',
      checked.invented.length ? `MCP-tool-shaped name(s) in README with no code behind them: ${checked.invented.join(', ')}` : '',
    ].filter(Boolean).join('\n'),
  );
});
