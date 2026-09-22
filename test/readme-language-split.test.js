'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// The bilingual file splits at "## 中文说明": everything above it is what an
// English reader sees, so it may not carry CJK text or CJK punctuation. A link
// into the Chinese half therefore has to target an ASCII anchor id, not the
// heading's own Chinese text. Han ideographs, CJK punctuation, and fullwidth
// forms are all counted; the boundary heading itself is the first line of the
// Chinese half and is out of scope.
const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;

const lines = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').split(/\r?\n/);
const boundary = lines.findIndex((line) => line.startsWith('## 中文说明'));
assert.notEqual(boundary, -1, 'README lost the Chinese-half boundary heading the two halves split on');
const englishHalf = lines.slice(0, boundary);

test('the English half carries no CJK', () => {
  const offenders = [];
  englishHalf.forEach((line, index) => {
    if (CJK.test(line)) offenders.push(`README.md:${index + 1} ${JSON.stringify(line.slice(0, 80))}`);
  });
  assert.deepEqual(offenders, [], `${offenders.length} CJK line(s) in the English half:\n${offenders.join('\n')}`);
});

test('the English half links only to anchors that exist', () => {
  const targets = new Set();
  for (const line of englishHalf) {
    for (const match of line.matchAll(/\]\(#([^)]+)\)/g)) targets.add(match[1]);
  }
  assert.ok(targets.size, 'the English half no longer links to any anchor; the scan is vacuous');
  const document = lines.join('\n');
  const missing = [...targets].filter((id) => !document.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `anchor(s) linked from the English half but defined nowhere: ${missing.join(', ')}`);
});
