'use strict';
// The desktop consent gate lives in the adapter, so a CLI that cannot name the
// flag is a flagship command with no legal route (wave 6.1). These tests drive
// bin/openacom.js with a stub adapter and a stubbed registry: nothing is spawned,
// no session database is opened, and 127.0.0.1:9222 is never contacted.
const { test } = require('node:test');
const assert = require('node:assert/strict');

function stubModule(relativeId, exports) {
  const id = require.resolve(relativeId);
  const previous = Object.prototype.hasOwnProperty.call(require.cache, id) ? require.cache[id] : undefined;
  require.cache[id] = { id, filename: id, loaded: true, exports, children: [], paths: [] };
  return () => { if (previous) require.cache[id] = previous; else delete require.cache[id]; };
}

class ExitSignal extends Error {
  constructor(code) { super(`process.exit(${code})`); this.exitCode = code; }
}

// lib/adapters/zcode.js routes a zcode resume to the desktop unless desktop is
// false, and that route refuses an unapproved submit. The stub restates exactly
// that contract, so the CLI is tested against the behaviour the real adapter has
// - including the case where the CLI passes nothing about consent at all.
const CONSENT_TEXT = 'ZCode desktop submit needs an explicit consent signal because it presses Enter in a live desktop window. Deliver mode "draft" instead (the text lands in the composer for the operator to review), or pass consent:true from a caller that has operator approval, or set OPENACOM_DESKTOP_CONSENT=1 in this process environment for a desktop you personally control.';
const SESSION_ID = 'task_stub';
function consentError() {
  return Object.assign(new Error(CONSENT_TEXT), { code: 'CONSENT_REQUIRED', uncertain: false });
}

function makeAdapter({ name = 'zcode', sendThrows = null, sendDesktopThrows = consentError } = {}) {
  const calls = [];
  const adapter = {
    name,
    available: () => true,
    list: () => [],
    messages: () => [],
    get: (id) => (id === 'task_stub' ? { id, title: 'Desktop target' } : null),
    sendDesktop(id, message, options) {
      calls.push({ fn: 'sendDesktop', id, message, options });
      const failure = sendDesktopThrows && sendDesktopThrows();
      if (failure) throw failure;
      return 'OK sent via CDP';
    },
    async send(id, message, options) {
      calls.push({ fn: 'send', id, message, options });
      if (sendThrows) throw sendThrows;
      if (options.desktopStrict === true) return 'OK drafted via CDP';
      if (options.desktop === false) return 'OK headless';
      if (options.consent === true) return 'OK sent via CDP';
      throw consentError();
    },
  };
  return { adapter, calls };
}

// captureExit drives the pure parser, which dies through process.exit too.
function captureExit(fn) {
  const realExit = process.exit;
  const realError = process.stderr.write;
  const exits = [];
  const stderr = [];
  process.exit = (code) => { exits.push(code === undefined ? 0 : code); throw new ExitSignal(code); };
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  try { fn(); } catch (error) { if (!(error instanceof ExitSignal)) throw error; } finally {
    process.exit = realExit;
    process.stderr.write = realError;
  }
  return { exits, stderr: stderr.join('') };
}

// Runs `openacom send ...` (or another subcommand) in-process and reports what the
// CLI did. `deliver` replaces the desktop transport so no CDP port is ever opened.
async function runCli(argv, adapter, { entry = 'cmdSend', deliver = null } = {}) {
  const restoreCore = stubModule('../lib/core', {
    findSession: () => [adapter],
    adaptersToUse: () => [adapter],
    ADAPTERS: { [adapter.name]: adapter },
  });
  const desktopCalls = [];
  const restoreDesktop = deliver ? stubModule('../lib/desktop-delivery', {
    deliverDesktop: async (session, text, options) => {
      desktopCalls.push({ session, text, options });
      return deliver(session, text, options);
    },
  }) : null;
  const cliId = require.resolve('../bin/openacom.js');
  delete require.cache[cliId];
  const cli = require(cliId);
  const realExit = process.exit;
  const realError = process.stderr.write;
  const realLog = console.log;
  const exits = [];
  const stderr = [];
  const stdout = [];
  process.exit = (code) => { exits.push(code === undefined ? 0 : code); throw new ExitSignal(code); };
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  console.log = (...args) => { stdout.push(args.join(' ')); };
  let failure = null;
  try {
    await cli[entry](cli.parseArgs(argv));
  } catch (error) {
    if (!(error instanceof ExitSignal)) failure = error;
  } finally {
    process.exit = realExit;
    process.stderr.write = realError;
    console.log = realLog;
    if (restoreDesktop) restoreDesktop();
    restoreCore();
  }
  return { exits, stderr: stderr.join(''), stdout: stdout.join(''), failure, cli, desktopCalls };
}

test('parseArgs: --consent carries a real boolean, and only when it was given', () => {
  const cli = require('../bin/openacom.js');
  assert.equal(cli.parseArgs(['s', 'hi', '--consent', 'true']).consent, true);
  assert.equal(cli.parseArgs(['s', 'hi', '--consent', 'false']).consent, false);
  assert.equal(Object.hasOwn(cli.parseArgs(['s', 'hi']), 'consent'), false, 'no flag must not become an implied false');
  assert.equal(cli.parseArgs(['s', 'hi', '--draft']).draft, true);
  assert.equal(Object.hasOwn(cli.parseArgs(['s', 'hi']), 'draft'), false);
  assert.deepEqual(cli.parseArgs(['s', 'hi', '--consent', 'true'])._, ['s', 'hi'], 'the value is not a positional');
  // The value must not swallow the next flag or run out of arguments.
  for (const argv of [['s', 'hi', '--consent'], ['s', 'hi', '--consent', '--draft'], ['s', 'hi', '--consent', '']]) {
    const captured = captureExit(() => cli.parseArgs(argv));
    assert.equal(captured.exits.length, 1, `"${argv.slice(2).join(' ')}" must stop the command`);
    assert.match(captured.stderr, /--consent/);
  }
});

test('parseArgs: a non-boolean consent value is refused, never coerced', () => {
  const cli = require('../bin/openacom.js');
  for (const value of ['yes', '1', 'TRUE', '0', 'no']) {
    const captured = captureExit(() => cli.parseArgs(['s', 'hi', '--consent', value]));
    assert.equal(captured.exits[0], 1, `"${value}" is not a boolean`);
    assert.match(captured.stderr, /takes true or false/);
    assert.match(captured.stderr, /--consent true/, 'the rejection has to show the accepted form');
  }
});

test('the default resume route surfaces CONSENT_REQUIRED and passes no consent claim', async () => {
  const { adapter, calls } = makeAdapter();
  const result = await runCli(['task_stub', 'hello'], adapter);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fn, 'send');
  assert.equal(calls[0].options.consent, undefined, 'the CLI must not invent a consent claim');
  assert.equal(calls[0].options.desktop, undefined, 'routing stays with the adapter');
  assert.equal(result.failure, null, 'the refusal exits, it does not throw out of main');
  assert.deepEqual(result.exits, [1], 'a refused submit is a failed command');
  assert.match(result.stderr, /CONSENT_REQUIRED/);
  assert.doesNotMatch(result.stderr, /explicit consent signal because it presses Enter/, 'the adapter paragraph is not repeated at a terminal');
});

test('the refusal prints the two copyable ways out, both naming the injected route', async () => {
  const { adapter } = makeAdapter();
  const result = await runCli(['task_stub', 'hello there'], adapter);
  assert.match(result.stderr, /openacom send task_stub <message> --desktop --draft/);
  assert.match(result.stderr, /openacom send task_stub <message> --desktop --consent true/);
  assert.match(result.stderr, /nothing was typed/, 'and it has to say the target is untouched');
});

test('--consent true reaches the legacy desktop sender through --desktop', async () => {
  const { adapter, calls } = makeAdapter({ sendDesktopThrows: null });
  const result = await runCli(['task_stub', 'hello', '--desktop', '--consent', 'true'], adapter);
  assert.equal(calls[0].fn, 'sendDesktop');
  assert.equal(calls[0].options.consent, true);
  assert.equal(calls[0].options.mode, undefined, 'submit is the only thing this transport does');
  assert.match(result.stdout, /OK sent via CDP/);
  assert.deepEqual(result.exits, [], 'a completed send does not exit nonzero');
});

test('--desktop without a consent claim sends no consent key at all', async () => {
  const { adapter, calls } = makeAdapter();
  const result = await runCli(['task_stub', 'hello', '--desktop'], adapter);
  assert.equal(calls[0].fn, 'sendDesktop');
  assert.deepEqual(calls[0].options, {}, 'an empty option object, not consent:false');
  assert.match(result.stderr, /CONSENT_REQUIRED/);
  assert.deepEqual(result.exits, [1]);
});

test('--consent true on the default route reaches the desktop submit', async () => {
  const { adapter, calls } = makeAdapter();
  const result = await runCli(['task_stub', 'hello', '--consent', 'true'], adapter);
  assert.equal(calls[0].fn, 'send');
  assert.equal(calls[0].options.consent, true);
  assert.match(result.stdout, /OK sent via CDP/);
  assert.deepEqual(result.exits, []);
});

test('--desktop --draft asks the strict sender for a draft and needs no consent', async () => {
  const { adapter, calls } = makeAdapter();
  const result = await runCli(['task_stub', 'hello', '--desktop', '--draft'], adapter);
  assert.equal(calls[0].fn, 'send', 'draft is not the legacy transport');
  assert.equal(calls[0].options.desktop, true);
  assert.equal(calls[0].options.desktopStrict, true, 'only the strict sender can stop before Enter');
  assert.equal(calls[0].options.mode, 'draft');
  assert.match(result.stdout, /OK drafted via CDP/);
  assert.deepEqual(result.exits, [], 'a draft presses no Enter, so the gate never applies');
});

test('--draft on its own is refused instead of silently changing the route', async () => {
  const { adapter, calls } = makeAdapter();
  const result = await runCli(['task_stub', 'hello', '--draft'], adapter);
  assert.deepEqual(calls, [], 'the refusal happens before anything is delivered');
  assert.match(result.stderr, /--draft needs the explicit desktop route/);
  assert.match(result.stderr, /openacom send task_stub <message> --desktop --draft/);
  assert.deepEqual(result.exits, [1]);
});

test('--draft and --consent contradict --no-desktop and say so', async () => {
  for (const argv of [['task_stub', 'hi', '--no-desktop', '--draft'], ['task_stub', 'hi', '--no-desktop', '--consent', 'true']]) {
    const { adapter, calls } = makeAdapter();
    const result = await runCli(argv, adapter);
    assert.deepEqual(calls, [], `"${argv.slice(2).join(' ')}" must be refused before delivery`);
    assert.deepEqual(result.exits, [1]);
    assert.match(result.stderr, /--no-desktop/);
  }
});

test('a draft or a consent claim on another agent is refused, not ignored', async () => {
  const claude = makeAdapter({ name: 'claude' });
  const drafted = await runCli(['sess_c', 'hi', '--draft'], claude.adapter);
  assert.deepEqual(claude.calls, []);
  assert.match(drafted.stderr, /zcode desktop composer feature/);

  const oc = makeAdapter({ name: 'opencode' });
  const consented = await runCli(['sess_o', 'hi', '--consent', 'true'], oc.adapter);
  assert.deepEqual(oc.calls, []);
  assert.match(consented.stderr, /only applies to a zcode desktop submit/);
  assert.deepEqual(consented.exits, [1]);
});

test('an unrelated adapter failure still surfaces verbatim', async () => {
  const missing = new Error('zcode CLI (zcode.cjs) not found; set AGENTRELAY_ZCODE_CLI to its full path');
  const { adapter } = makeAdapter({ sendThrows: missing });
  const result = await runCli(['task_stub', 'hello', '--consent', 'true'], adapter);
  assert.match(result.stderr, /error: zcode CLI \(zcode\.cjs\) not found/);
  assert.doesNotMatch(result.stderr, /--draft/, 'no consent advice attached to an unrelated failure');
  assert.deepEqual(result.exits, [1]);
});

test('send-desktop injects through the transport and reports what it used', async () => {
  const { adapter } = makeAdapter();
  const deliver = async () => ({ status: 'submitted', outcome: 'input-submitted', transport: 'cdp', sessionId: SESSION_ID, cdpPort: 9222, textLength: 5, consent: true, uncertain: false, note: 'submitted through the ZCode desktop debugger on 127.0.0.1:9222' });
  const ok = await runCli([SESSION_ID, 'hello', '--consent', 'true'], adapter, { entry: 'cmdSendDesktop', deliver });
  assert.deepEqual(ok.desktopCalls[0].options, { consent: true });
  assert.equal(ok.desktopCalls[0].session.title, 'Desktop target', 'the session row comes from the adapter, not from the user');
  assert.equal(ok.desktopCalls[0].text, 'hello');
  assert.match(ok.stdout, /OK via CDP - input-submitted on task_stub/);
  assert.deepEqual(ok.exits, []);
  const parsed = JSON.parse((await runCli([SESSION_ID, 'hello', '--consent', 'true', '--json'], adapter, { entry: 'cmdSendDesktop', deliver })).stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.transport, 'cdp');
  assert.equal(parsed.textLength, 5, 'the text itself is never echoed back');
  const uia = await runCli([SESSION_ID, 'hello', '--consent', 'true'], adapter, {
    entry: 'cmdSendDesktop',
    deliver: async () => ({ status: 'submitted', outcome: 'input-submitted-via-uia', transport: 'uia', sessionId: SESSION_ID, cdpPort: 9222, textLength: 5, consent: true, uncertain: false, note: 'OK sent to window' }),
  });
  assert.match(uia.stdout, /UIA: focus was taken to type it/, 'the focus steal is said out loud');
});

test('send-desktop without consent is refused with its own way out', async () => {
  const { adapter } = makeAdapter();
  const result = await runCli([SESSION_ID, 'hello'], adapter, {
    entry: 'cmdSendDesktop',
    deliver: async () => { throw consentError(); },
  });
  assert.deepEqual(result.desktopCalls[0].options, { consent: false }, 'the CLI does not invent approval');
  assert.match(result.stderr, /CONSENT_REQUIRED/);
  assert.match(result.stderr, /openacom send-desktop task_stub <message> --consent true/);
  assert.match(result.stderr, /OPENACOM_DESKTOP_CONSENT=1/);
  assert.doesNotMatch(result.stderr, /--desktop --draft/, 'the send() advice does not belong to this command');
  assert.deepEqual(result.exits, [1]);
});

test('send-desktop refuses a flag combination that would not inject', async () => {
  for (const argv of [[SESSION_ID, 'hi', '--consent', 'false'], [SESSION_ID, 'hi', '--no-desktop']]) {
    const { adapter } = makeAdapter();
    const result = await runCli(argv, adapter, {
      entry: 'cmdSendDesktop',
      deliver: async () => { throw new Error('the transport must not be reached'); },
    });
    assert.deepEqual(result.desktopCalls, [], `"${argv.slice(2).join(' ')}" is refused before delivery`);
    assert.deepEqual(result.exits, [1]);
  }
  const claude = makeAdapter({ name: 'claude' });
  const wrongAgent = await runCli(['sess_c', 'hi', '--consent', 'true'], claude.adapter, { entry: 'cmdSendDesktop', deliver: async () => ({ transport: 'cdp' }) });
  assert.match(wrongAgent.stderr, /send-desktop injects into the ZCode desktop UI; sess_c is a claude session/);
  assert.deepEqual(claude.calls, [], 'no delivery call for a session this command cannot inject into');
  const noText = await runCli([SESSION_ID], makeAdapter().adapter, { entry: 'cmdSendDesktop', deliver: async () => ({}) });
  assert.match(noText.stderr, /send-desktop needs: <sessionId> <message\.\.\.>/);
});

test('a hard transport error is reported as it is, with no invented consent hint', async () => {
  const { adapter } = makeAdapter();
  const result = await runCli([SESSION_ID, 'hi', '--consent', 'true'], adapter, {
    entry: 'cmdSendDesktop',
    deliver: async () => { throw Object.assign(new Error('127.0.0.1:9222 is not the ZCode desktop debugger (no fallback was attempted)'), { code: 'CDP_IDENTITY', uncertain: false, attempted: ['cdp'] }); },
  });
  assert.match(result.stderr, /CDP_IDENTITY|not the ZCode desktop debugger/);
  assert.doesNotMatch(result.stderr, /--consent true/, 'the user already gave consent; repeating it is noise');
  assert.deepEqual(result.exits, [1]);
});

test('HELP documents both flags as injection options, not as a send default', () => {
  const cli = require('../bin/openacom.js');
  assert.match(cli.HELP, /--consent true\|false/);
  assert.match(cli.HELP, /--draft/);
  assert.match(cli.HELP, /CONSENT_REQUIRED/);
  assert.match(cli.HELP, /OPENACOM_DESKTOP_CONSENT=1/);
  assert.match(cli.HELP, /The injected desktop route/, 'the desktop path is named as a route you choose');
  assert.match(cli.HELP, /openacom send-desktop <sessionId> <message\.\.\.>/, 'the named injection entry point is documented');
  assert.match(cli.HELP, /send-desktop is the named injection entry point/);
  assert.match(cli.HELP, /flags about INJECTION/);
  assert.match(cli.HELP, /None of them is a precondition of sending/);
  // #22 turns the default into inbox delivery, so the CLI text must not have
  // claimed a default route first - then this bullet survives that change intact.
  assert.doesNotMatch(cli.HELP, /DEFAULTS TO THE DESKTOP|默认走桌面|desktop by default|defaults to the desktop/i);
});
