#!/usr/bin/env node
'use strict';
const { homedir } = require('os');
const path = require('path');

const ZCODE_CJS_CANDIDATES = () => [
  process.env.AGENTRELAY_ZCODE_CLI,
  process.env.ZCODE_WINDOWS_APP_INSTALL_DIR && path.join(process.env.ZCODE_WINDOWS_APP_INSTALL_DIR, 'resources', 'glm', 'zcode.cjs'),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs'),
  '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
  path.join(homedir(), '.zcode', 'cli', 'zcode.cjs'),
].filter(Boolean);

function resolveZcodeCli() {
  const fs = require('fs');
  for (const p of ZCODE_CJS_CANDIDATES()) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

function zcodeConfigPath() {
  return path.join(homedir(), '.zcode', 'cli', 'config.json');
}

function truncate(s, n) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function fmtTime(ms) {
  if (!ms) return '-';
  const d = Date.now() - ms;
  const min = 60e3, hour = 60 * min, day = 24 * hour;
  if (d < min) return 'just now';
  if (d < hour) return Math.floor(d / min) + 'm ago';
  if (d < day) return Math.floor(d / hour) + 'h ago';
  return Math.floor(d / day) + 'd ago';
}

function printTable(rows, headers) {
  const cols = headers.map((h) => h.key);
  const widths = headers.map((h) => h.label.length);
  const text = rows.map((r) => cols.map((c, i) => {
    const v = truncate(r[c], 60);
    widths[i] = Math.max(widths[i], String(v).length);
    return v;
  }));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log(line(headers.map((h) => h.label)));
  console.log(line(widths.map((w) => '-'.repeat(w))));
  for (const t of text) console.log(line(t));
}

// Run a command capturing stdout/stderr with a timeout.
// On Windows npm shims are .cmd files, which need a shell; args are then joined
// into one quoted command string (they are always controlled flags/ids — user
// payloads travel via stdin, never via argv).
function run(cmd, args, { cwd, timeoutMs = 600e3, input } = {}) {
  const { spawnSync } = require('child_process');
  const isWin = process.platform === 'win32';
  const q = (s) => (/[\s"^&|<>()%]/.test(s) ? `"${String(s).replace(/"/g, '')}"` : s);
  const r = isWin
    ? spawnSync([cmd, ...args].map(q).join(' '), {
        cwd, timeout: timeoutMs, input: input == null ? undefined : input,
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: true, windowsHide: true,
      })
    : spawnSync(cmd, args, {
        cwd, timeout: timeoutMs, input: input == null ? undefined : input,
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
      });
  return r;
}

function whichCli(name) {
  const r = run('where', [name], { timeoutMs: 10e3 });
  const hit = process.platform === 'win32'
    ? r.status === 0 && String(r.stdout || '').split(/\r?\n/)[0]
    : null;
  if (hit) return hit;
  const u = run('sh', ['-c', `command -v ${name}`], { timeoutMs: 10e3 });
  return u.status === 0 && String(u.stdout || '').trim();
}

module.exports = {
  resolveZcodeCli, zcodeConfigPath, truncate, fmtTime, printTable, run, whichCli,
};
