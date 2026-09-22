'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// Two shipped defects came from writing an escape as a real byte instead of as
// text: a backspace inside a regex in lib/adapters/opencode.js, and a carriage
// return in a documented path in README.md. Source has no reason to carry C0
// bytes at all, so the whole tree is gated on them.
// TAB is layout, and LF/CR are line endings (this repo checks out CRLF on
// Windows with core.autocrlf=true), so those three are permitted.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
// A CR that does not start a CRLF pair can only be a literal byte that a line
// ending never asked for.
const LONE_CR = /\r(?!\n)/g;

const GROUPS = [
  { label: 'lib/**/*.js', dir: 'lib', keep: (file) => file.endsWith('.js') },
  { label: 'bin/**/*.js', dir: 'bin', keep: (file) => file.endsWith('.js') },
  { label: 'tools/**/*.js', dir: 'tools', keep: (file) => file.endsWith('.js') },
  { label: 'README.md', file: 'README.md' },
];

function javascriptFiles(directory) {
  const found = [];
  for (const entry of fs.readdirSync(path.join(ROOT, directory), { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...javascriptFiles(relative));
    else if (entry.isFile() && relative.endsWith('.js')) found.push(relative);
  }
  return found.sort();
}

function position(text, index) {
  const line = text.slice(0, index).split('\n').length;
  const start = text.lastIndexOf('\n', index - 1) + 1;
  return { line, column: index - start + 1 };
}

function analyze(relative, text) {
  const found = [];
  const collect = (regex, kind) => {
    for (const match of text.matchAll(regex)) {
      const { line, column } = position(text, match.index);
      found.push(`${relative}:${line}:${column} ${kind} 0x${match[0].charCodeAt(0).toString(16).padStart(2, '0')}`);
    }
  };
  collect(CONTROL, 'literal control byte');
  collect(LONE_CR, 'carriage return outside a CRLF pair');
  return found;
}

function scan(relative) {
  // latin1 keeps every byte of the file addressable as one character, so a
  // control byte inside a multi-byte UTF-8 sequence is still reported.
  return analyze(relative, fs.readFileSync(path.join(ROOT, relative), 'latin1'));
}

test('scanned sources carry no literal control bytes', async () => {
  // Self-check first: a gate that cannot report anything is not a gate.
  assert.deepEqual(analyze('sample.js', 'const re = /a\u0008b/;\r\nconst cr = "a\rb";\r\n'), [
    'sample.js:1:14 literal control byte 0x08',
    'sample.js:2:14 carriage return outside a CRLF pair 0x0d',
  ]);
  assert.deepEqual(analyze('sample.js', 'ok\t\n\r\nconst 路径 = "a\u00e2\u0080\u0099b";\n'), []);

  const targets = [];
  for (const group of GROUPS) {
    const files = group.file ? [group.file] : javascriptFiles(group.dir).filter(group.keep);
    assert.ok(files.length, `hygiene gate found no files for ${group.label}; the scan is vacuous`);
    targets.push(...files);
  }
  assert.equal(targets.length, new Set(targets).size, 'hygiene gate scans a file twice');
  const offenders = targets.flatMap(scan);
  const byFile = new Map();
  for (const offender of offenders) {
    const file = offender.split(':')[0];
    byFile.set(file, (byFile.get(file) || 0) + 1);
  }
  const summary = [...byFile].map(([file, count]) => `${file} (${count})`).join(', ');
  assert.equal(
    offenders.length,
    0,
    `${offenders.length} byte(s) outside the source hygiene gate in ${byFile.size} file(s): ${summary}\n` + offenders.join('\n'),
  );
});
