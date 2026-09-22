'use strict';
// deliverDesktop is the single desktop INJECTION transport: its whole job is to
// decide what may and may not change the route. These tests pin that policy with
// a scripted sender and a fake powershell; the two stub-endpoint cases run the
// real CDP verification chain against a local http stub. Nothing here listens on
// 9222, touches a live session, or types into a real window.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { deliverDesktop, uiSend } = require('../lib/desktop-delivery');

const SESSION = { id: 'task_1', title: 'Injection target' };
const CONSENT_KEYS = ['OPENACOM_DESKTOP_CONSENT', 'AGENTRELAY_DESKTOP_CONSENT'];

function useConsentFreeEnv() {
  const before = CONSENT_KEYS.map((key) => [key, process.env[key]]);
  // A real operator machine may carry the resident desktop-consent file in the
  // real home; a consent-free run must not inherit that grant.
  const beforeHome = process.env.AGENTRELAY_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'openacom-consent-'));
  for (const key of CONSENT_KEYS) delete process.env[key];
  process.env.AGENTRELAY_HOME = home;
  return () => {
    for (const [key, value] of before) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (beforeHome === undefined) delete process.env.AGENTRELAY_HOME; else process.env.AGENTRELAY_HOME = beforeHome;
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  };
}

function fakeSpawn(...results) {
  const calls = [];
  const queue = [...results];
  return {
    calls,
    spawn: (command, argv, options) => {
      calls.push({ command, argv, options });
      const next = queue.shift();
      return next || { status: 1, stdout: '', stderr: '' };
    },
  };
}

const senderThat = {
  submitted: async () => ({ status: 'submitted', outcome: 'input-submitted' }),
  failing: (code, uncertain = false) => async () => {
    throw Object.assign(new Error(`${code} from the scripted sender`), { code, uncertain });
  },
};

test('a draft asked of the injection transport is refused, not silently submitted', async () => {
  const restore = useConsentFreeEnv();
  const spawns = fakeSpawn();
  const sends = [];
  try {
    await assert.rejects(deliverDesktop(SESSION, 'text', {
      mode: 'draft', consent: true, platform: 'win32', spawn: spawns.spawn,
      strictSender: async (...args) => { sends.push(args); return { status: 'drafted' }; },
    }), (error) => {
      assert.equal(error.code, 'INVALID_MODE');
      assert.equal(error.uncertain, false);
      assert.match(error.message, /sendDesktopStrict/);
      return true;
    });
    assert.deepEqual(sends, [], 'the transport was never reached');
    assert.deepEqual(spawns.calls, [], 'and no fallback either');
  } finally { restore(); }
});

test('the consent gate is unchanged by the new entry point', async () => {
  const restore = useConsentFreeEnv();
  const spawns = fakeSpawn();
  let senderCalls = 0;
  const options = {
    platform: 'win32', spawn: spawns.spawn, timeoutMs: 4000,
    strictSender: async () => { senderCalls += 1; return { status: 'submitted', outcome: 'input-submitted' }; },
  };
  try {
    await assert.rejects(deliverDesktop(SESSION, 'text', options), (error) => {
      assert.equal(error.code, 'CONSENT_REQUIRED');
      assert.equal(error.uncertain, false);
      return true;
    });
    await assert.rejects(deliverDesktop(SESSION, 'text', { ...options, consent: false }), /consent/i);
    assert.equal(senderCalls, 0, 'an unapproved submit may not even look at the endpoint');
    assert.deepEqual(spawns.calls, [], 'nor at the UIA sender');
    // The resident grant still works, and only for a desktop the operator owns.
    process.env.OPENACOM_DESKTOP_CONSENT = '1';
    const granted = await deliverDesktop(SESSION, 'text', options);
    assert.equal(granted.transport, 'cdp');
    assert.equal(senderCalls, 1);
    process.env.OPENACOM_DESKTOP_CONSENT = 'yes';
    await assert.rejects(deliverDesktop(SESSION, 'text', { ...options, strictSender: senderThat.submitted }), /consent/i, 'only the literal "1" is a grant');
  } finally { restore(); }
});

test('a resident desktop-consent file grants submit, and only with the literal "1"', async () => {
  const restore = useConsentFreeEnv();
  const spawns = fakeSpawn();
  let senderCalls = 0;
  const options = {
    platform: 'win32', spawn: spawns.spawn, timeoutMs: 4000,
    strictSender: async () => { senderCalls += 1; return { status: 'submitted', outcome: 'input-submitted' }; },
  };
  try {
    const grantFile = path.join(process.env.AGENTRELAY_HOME, 'desktop-consent');
    fs.writeFileSync(grantFile, 'yes');
    await assert.rejects(deliverDesktop(SESSION, 'text', options), /consent/i, 'a mistyped file is not a grant');
    assert.equal(senderCalls, 0);
    fs.writeFileSync(grantFile, '1\n');
    const granted = await deliverDesktop(SESSION, 'text', options);
    assert.equal(granted.transport, 'cdp');
    assert.equal(senderCalls, 1);
    fs.rmSync(grantFile, { force: true });
    await assert.rejects(deliverDesktop(SESSION, 'text', options), /consent/i, 'deleting the file revokes the grant');
    assert.equal(senderCalls, 1);
  } finally { restore(); }
});

test('an approved submit reports what it did, in a shape the tool layer can pass through', async () => {
  const restore = useConsentFreeEnv();
  const seen = [];
  try {
    const outcome = await deliverDesktop(SESSION, 'hello there', {
      consent: true, cdpPort: 9444, cdpTargetId: 'PAGE1', timeoutMs: 5000, platform: 'win32',
      strictSender: async (session, text, options) => { seen.push({ session, text, options }); return { status: 'submitted', outcome: 'input-submitted' }; },
    });
    assert.deepEqual(outcome, {
      status: 'submitted',
      sessionId: 'task_1',
      cdpPort: 9444,
      textLength: 11,
      consent: true,
      uncertain: false,
      outcome: 'input-submitted',
      transport: 'cdp',
      note: 'submitted through the ZCode desktop debugger on 127.0.0.1:9444',
    });
    assert.deepEqual(seen[0].options, { mode: 'submit', consent: true, cdpPort: 9444, cdpTargetId: 'PAGE1', timeoutMs: 5000 }, 'the submit is the only mode it asks for');
    assert.equal(seen[0].text, 'hello there');
    assert.ok(!JSON.stringify(outcome).includes('hello there'), 'the outcome never carries the text back out');
  } finally { restore(); }
});

test('an identity mismatch is a hard error: no second transport, no replay', async () => {
  const restore = useConsentFreeEnv();
  const spawns = fakeSpawn({ status: 0, stdout: 'OK sent via UIA', stderr: '' });
  try {
    await assert.rejects(deliverDesktop(SESSION, 'text', {
      consent: true, platform: 'win32', spawn: spawns.spawn,
      strictSender: senderThat.failing('CDP_IDENTITY'),
    }), (error) => {
      assert.equal(error.code, 'CDP_IDENTITY');
      assert.equal(error.uncertain, false);
      assert.deepEqual(error.attempted, ['cdp']);
      assert.match(error.message, /no fallback was attempted/);
      return true;
    });
    assert.deepEqual(spawns.calls, [], 'an endpoint that answered is never re-delivered through UIA');
    for (const code of ['INPUT_UNCERTAIN', 'DESKTOP_TIMEOUT', 'DESKTOP_CLOSED', 'INPUT_BUSY', 'DESKTOP_TARGET']) {
      spawns.calls.length = 0;
      await assert.rejects(deliverDesktop(SESSION, 'text', {
        consent: true, platform: 'win32', spawn: spawns.spawn, strictSender: senderThat.failing(code, code === 'INPUT_UNCERTAIN' || code === 'DESKTOP_TIMEOUT'),
      }), (error) => {
        assert.equal(error.code, code, `${code} keeps its own code`);
        assert.deepEqual(error.attempted, ['cdp']);
        return true;
      });
      assert.deepEqual(spawns.calls, [], `${code} must not change transport either`);
    }
  } finally { restore(); }
});

test('only a port that never answered as CDP may go on through the UIA sender', async () => {
  const restore = useConsentFreeEnv();
  const spawns = fakeSpawn({ status: 0, stdout: 'OK sent to window', stderr: '' });
  try {
    const outcome = await deliverDesktop(SESSION, 'text', {
      consent: true, platform: 'win32', spawn: spawns.spawn, ps1: 'C:\\tmp\\desktop-send.ps1',
      strictSender: senderThat.failing('DESKTOP_UNAVAILABLE'),
    });
    assert.equal(outcome.transport, 'uia', 'the fallback is visible in the result, not hidden');
    assert.equal(outcome.outcome, 'input-submitted-via-uia');
    assert.equal(outcome.note, 'OK sent to window');
    assert.equal(spawns.calls.length, 1);
    assert.equal(spawns.calls[0].command, 'powershell');
    assert.deepEqual(spawns.calls[0].argv.slice(0, 5), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\tmp\\desktop-send.ps1']);
    assert.equal(Buffer.from(spawns.calls[0].argv[spawns.calls[0].argv.indexOf('-TitleB64') + 1], 'base64').toString('utf8'), 'Injection target');
    assert.equal(Buffer.from(spawns.calls[0].argv[spawns.calls[0].argv.indexOf('-MessageB64') + 1], 'base64').toString('utf8'), 'text', 'the text is passed base64, never through a shell line');
  } finally { restore(); }
});

test('a UIA sender that fails is an error, and its uncertainty is inherited', async () => {
  const restore = useConsentFreeEnv();
  try {
    const ran = fakeSpawn({ status: 1, stdout: '', stderr: 'window not found' });
    await assert.rejects(deliverDesktop(SESSION, 'text', {
      consent: true, platform: 'win32', spawn: ran.spawn, strictSender: senderThat.failing('DESKTOP_UNAVAILABLE'),
    }), (error) => {
      assert.equal(error.code, 'DESKTOP_UIA');
      assert.equal(error.uncertain, true, 'powershell ran, so it may have typed before failing');
      assert.deepEqual(error.attempted, ['cdp', 'uia']);
      assert.match(error.message, /failed on both transports/);
      assert.match(error.message, /DESKTOP_UNAVAILABLE from the scripted sender/, 'the first transport reason survives');
      return true;
    });
    const couldNotStart = fakeSpawn({ error: Object.assign(new Error('no powershell'), { code: 'ENOENT' }), status: null });
    await assert.rejects(deliverDesktop(SESSION, 'text', {
      consent: true, platform: 'win32', spawn: couldNotStart.spawn, strictSender: senderThat.failing('DESKTOP_UNAVAILABLE'),
    }), (error) => {
      assert.equal(error.code, 'DESKTOP_UIA');
      assert.equal(error.uncertain, false, 'nothing could have been typed if the sender never started');
      return true;
    });
    // An ERR line from the script is a failure, not a success with a note.
    const errored = fakeSpawn({ status: 0, stdout: 'ERR no such window', stderr: '' });
    assert.throws(() => uiSend(SESSION, 'text', { spawn: errored.spawn }), (error) => {
      assert.equal(error.code, 'DESKTOP_UIA');
      assert.equal(error.uncertain, true, 'powershell may have typed before the ERR line');
      return true;
    });
  } finally { restore(); }
});

test('preflight refusals happen before anything could be touched', async () => {
  const restore = useConsentFreeEnv();
  const spawns = fakeSpawn();
  let senderCalls = 0;
  const strictSender = async () => { senderCalls += 1; return { status: 'submitted' }; };
  const options = { consent: true, platform: 'win32', spawn: spawns.spawn, strictSender };
  try {
    const cases = [
      [{ ...SESSION, title: '   ' }, 'DESKTOP_TARGET'],
      [{ id: 'x' }, 'DESKTOP_TARGET'],
      [null, 'DESKTOP_TARGET'],
      [{ id: '', title: 't' }, 'DESKTOP_TARGET'],
    ];
    for (const [session, code] of cases) {
      await assert.rejects(deliverDesktop(session, 'text', options), (error) => {
        assert.equal(error.code, code, `${JSON.stringify(session)} is not an injectable session`);
        assert.equal(error.uncertain, false);
        return true;
      });
    }
    await assert.rejects(deliverDesktop(SESSION, '', options), (error) => {
      assert.equal(error.code, 'INVALID_TEXT');
      return true;
    });
    await assert.rejects(deliverDesktop(SESSION, 'text', { ...options, platform: 'linux' }), (error) => {
      assert.equal(error.code, 'DESKTOP_PLATFORM');
      assert.match(error.message, /Windows-only/);
      return true;
    });
    assert.equal(senderCalls, 0);
    assert.deepEqual(spawns.calls, []);
  } finally { restore(); }
});

// The real chain, with no seam: an HTTP stub that answers as a plain Chrome
// debugger must be refused as an impostor, and the UIA sender must never be
// reached - the same proof as above, through verifyCdpEndpoint.
function startCdpStub(version, pages) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    const value = request.url === '/json/version' ? version : request.url === '/json' ? pages : undefined;
    if (value === undefined) { response.writeHead(404); response.end('not found'); return; }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  });
  server.on('upgrade', (request) => request.socket.destroy());
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port, requests,
    close: () => new Promise((done) => { server.close(done); server.closeAllConnections?.(); }),
  })));
}

const ELECTRON_VERSION = {
  Browser: 'Chrome/120.0.6099.291',
  'Protocol-Version': '1.3',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ZCode/2.4.0 Chrome/120.0.6099.291 Electron/28.2.0 Safari/537.36',
};
const LOCAL_PAGE = { id: 'PAGE1', type: 'page', title: 'ZCode', url: 'file:///C:/ZCode/resources/app/index.html' };

test('a real impostor endpoint is refused with no UIA attempt', async () => {
  const restore = useConsentFreeEnv();
  const spawns = fakeSpawn({ status: 0, stdout: 'OK', stderr: '' });
  const stub = await startCdpStub({ Browser: 'Chrome/120.0.0.0', 'User-Agent': 'Mozilla/5.0 Chrome/120.0.0.0' }, [LOCAL_PAGE]);
  try {
    await assert.rejects(deliverDesktop(SESSION, 'text', {
      consent: true, cdpPort: stub.port, timeoutMs: 4000, platform: 'win32', spawn: spawns.spawn,
    }), (error) => {
      assert.equal(error.code, 'CDP_IDENTITY');
      assert.equal(error.uncertain, false);
      return true;
    });
    assert.deepEqual(spawns.calls, [], 'the impostor is not handed to the fallback either');
    assert.deepEqual(stub.requests, ['/json/version']);
  } finally {
    await stub.close();
    restore();
  }
});

test('a real dead port and a dead page socket each take exactly one UIA branch', async () => {
  const restore = useConsentFreeEnv();
  const dead = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
  const spawns = fakeSpawn({ status: 0, stdout: 'OK sent to window', stderr: '' });
  try {
    const outcome = await deliverDesktop(SESSION, 'text', {
      consent: true, cdpPort: dead, timeoutMs: 4000, platform: 'win32', spawn: spawns.spawn,
    });
    assert.equal(outcome.transport, 'uia');
    assert.equal(spawns.calls.length, 1, 'one fallback attempt, not a retry loop');
  } finally { restore(); }

  // A verified ZCode endpoint whose page socket then dies: nothing was typed, so
  // the one UIA branch is still allowed - but the identity checks really ran, and
  // there is exactly one fallback attempt either way.
  const spawns2 = fakeSpawn({ status: 0, stdout: 'OK sent to window', stderr: '' });
  const stub = await startCdpStub(ELECTRON_VERSION, [LOCAL_PAGE]);
  try {
    const outcome = await deliverDesktop(SESSION, 'text', {
      consent: true, cdpPort: stub.port, timeoutMs: 4000, platform: 'win32', spawn: spawns2.spawn,
    });
    assert.deepEqual(stub.requests, ['/json/version', '/json'], 'the endpoint was verified before anything else');
    assert.equal(outcome.transport, 'uia');
    assert.equal(spawns2.calls.length, 1, 'one fallback attempt, never a retry loop');
  } finally {
    await stub.close();
    restore();
  }
});
