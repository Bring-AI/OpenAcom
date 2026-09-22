'use strict';
const {test, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'openacom-routing-'));
process.env.AGENTRELAY_HOME = home;
delete process.env.OPENACOM_DESKTOP_CONSENT;
delete process.env.AGENTRELAY_DESKTOP_CONSENT;
delete process.env.OPENACOM_AGENT_ID;
const inbox = require('../lib/inbox');
const core = require('../lib/core');
const sdk = require('../lib/sdk');
const mcp = require('../lib/mcp');
const calls = [];
let sendResult = {status:'accepted'};
const adapter = {name:'zcode', available:()=>true, get:id=>id === 'one' ? {id,agent:'zcode'} : null,
  send:async (id, text, opts) => { calls.push({route:'session',id,text,opts}); assert.ok(inbox.get(opts.id)); return typeof sendResult === 'function' ? sendResult(opts) : sendResult; },
  sendDesktop:async (id,text,opts) => {calls.push({route:'desktop',id,text,opts}); assert.ok(inbox.get(opts.id)); return 'submitted';},
};
const original = core.ADAPTERS.zcode;
core.ADAPTERS.zcode = adapter;
const call = async args => (await mcp.handleMessage({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'send_message',arguments:args}})).result;
const value = result => JSON.parse(result.content[0].text);

test('explicit session MCP stores before session delivery and forwards stable identity without desktop fallback', async () => {
  const r = value(await call({to:'zcode:one',route:'session',from:'pi:sender',message:'hello',id:'one'}));
  assert.equal(r.status,'accepted'); assert.equal(r.route,'session');
  assert.equal(calls.length,1); assert.equal(calls[0].opts.requestId,'one'); assert.equal(calls[0].opts.desktop,false);
  assert.equal(inbox.get('one').text,'hello'); assert.equal(inbox.get('one').attempts,1);
  assert.equal(inbox.get('one').read_at,null);
  const replay = value(await call({to:'zcode:one',route:'session',from:'pi:sender',message:'hello',id:'one'}));
  assert.equal(replay.replayed,true); assert.equal(calls.length,1);
  const conflict = await call({to:'zcode:one',route:'session',from:'pi:sender',message:'hello',id:'one',route:'mailbox'});
  assert.equal(conflict.isError,true); assert.match(conflict.content[0].text,/ID_CONFLICT/);
});

test('uncertain sends stay in inbox and same-ID concurrent calls cannot dispatch twice', async () => {
  let finish;
  sendResult = () => new Promise(resolve=>{finish=resolve;});
  const pending = sdk.sendRouted('zcode:one','pending',{from:'pi:sender',route:'session',id:'pending'});
  assert.equal(inbox.get('pending').status,'uncertain');
  const duplicate = await sdk.sendRouted('zcode:one','pending',{from:'pi:sender',route:'session',id:'pending'});
  assert.equal(duplicate.status,'uncertain'); assert.equal(duplicate.replayed,true);
  const count = calls.length;
  finish({status:'uncertain',code:'INPUT_UNCONFIRMED'});
  assert.equal((await pending).status,'uncertain'); assert.equal(calls.length,count);
  assert.equal(inbox.get('pending').text,'pending');
  sendResult = () => {throw new Error('connection lost');};
  assert.equal((await sdk.sendRouted('zcode:one','lost',{from:'pi:sender',route:'session',id:'lost'})).status,'uncertain');
  assert.equal(inbox.get('lost').attempts,1);
});

test('desktop is explicit and strict; rejected desktop never falls back to session', async () => {
  const count=calls.length;
  const refused=value(await call({to:'zcode:one',message:'desktop',route:'desktop',id:'no-consent'}));
  assert.equal(refused.status,'refused'); assert.equal(refused.code,'CONSENT_REQUIRED');
  assert.equal(calls.length,count); assert.equal(inbox.get('no-consent').text,'desktop');
  const delivered=value(await call({to:'zcode:one',message:'desktop',route:'desktop',consent:true,id:'desktop'}));
  assert.equal(delivered.status,'accepted'); assert.equal(calls.at(-1).route,'desktop');
});

test('unknown routes refuse, unsupported targets retain message, mailbox is an explicit opt-out', async () => {
  const count=calls.length;
  const unknown=value(await call({to:'qoder:boss',message:'keep me',id:'unsupported'}));
  assert.equal(unknown.status,'refused'); assert.equal(unknown.code,'INJECT_UNSUPPORTED');
  assert.equal(inbox.get('unsupported').text,'keep me');
  const stored=value(await call({to:'zcode:one',message:'only store',route:'mailbox',id:'store'}));
  assert.equal(stored.status,'stored'); assert.equal(inbox.get('store').attempts,0);
  assert.equal(calls.length,count);
  for (const args of [{route:'ssh'}, {route:'session',mode:'draft'}, {route:'relay'}, {route:'mailbox',inject:true}]) {
    const bad=await call({to:'zcode:one',message:'invalid',...args}); assert.equal(bad.isError,true);
  }
});

test('auto relay uses remote target and failures do not touch a local session', async () => {
  const http = require('node:http');
  const received=[];
  const server=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk; received.push(JSON.parse(body));res.setHeader('Content-Type','application/json');res.end('{"status":"queued"}');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}`;
  const count=calls.length;
  try {
    const r=await sdk.sendRouted('node:remote/terminal','remote',{from:'pi:sender',id:'remote',url,token:'test-only-secret-'.repeat(4)});
    assert.equal(r.route,'relay'); assert.equal(r.status,'queued');
    assert.equal(received[0].id,'remote'); assert.equal(received[0].to,'remote');
    assert.equal(inbox.get('remote').status,'queued');
  } finally {await new Promise(resolve=>server.close(resolve));}
  const lost=await sdk.sendRouted('node:remote/terminal','lost',{from:'pi:sender',id:'remote-lost',url,token:'test-only-secret-'.repeat(4)});
  assert.equal(lost.status,'uncertain'); assert.equal(calls.length,count);
});

test('acknowledgement received during dispatch is not overwritten by delivery completion', async () => {
  sendResult = opts=>{inbox.markRead(opts.id);return {status:'accepted'};};
  await sdk.sendRouted('zcode:one','ack',{from:'pi:sender',route:'session',id:'ack'});
  assert.equal(inbox.get('ack').status,'read');
});

after(()=>{core.ADAPTERS.zcode=original;inbox.close();fs.rmSync(home,{recursive:true,force:true,maxRetries:8,retryDelay:100});});

test('CLI deliver shares persisted IDs and makes mailbox-only delivery explicit', () => {
  const {spawnSync}=require('node:child_process');
  const args=[path.join(__dirname,'../bin/openacom.js'),'deliver','pi:receiver','cli body','--from','pi:sender','--route','mailbox','--id','cli-id'];
  const first=spawnSync(process.execPath,args,{encoding:'utf8',env:{...process.env}});
  assert.equal(first.status,0,first.stderr); assert.equal(JSON.parse(first.stdout).status,'stored');
  const second=spawnSync(process.execPath,args,{encoding:'utf8',env:{...process.env}});
  assert.equal(JSON.parse(second.stdout).replayed,true);
  const refused=spawnSync(process.execPath,[path.join(__dirname,'../bin/openacom.js'),'deliver','qoder:unknown','keep','--from','pi:sender','--id','cli-refused'],{encoding:'utf8',env:{...process.env}});
  assert.equal(refused.status,1,refused.stderr); assert.equal(JSON.parse(refused.stdout).code,'INJECT_UNSUPPORTED');
  assert.equal(inbox.get('cli-refused').text,'keep');
});


test('zcode auto selects CDP only and never retries through UIA or session', async () => {
  const desktop = require('../lib/desktop-delivery');
  const original = desktop.sendDesktopStrict;
  const count = calls.length;
  const strictCalls = [];
  try {
    desktop.sendDesktopStrict = async (session,text,opts) => {
      strictCalls.push({session,text,opts});
      if (text.startsWith('unavailable')) throw Object.assign(new Error('CDP unavailable'), {code:'DESKTOP_UNAVAILABLE',uncertain:false});
      return {outcome:'input-submitted'};
    };
    const delivered=value(await call({to:'zcode:one',message:'cdp default',id:'auto-cdp',consent:true}));
    assert.equal(delivered.route,'desktopcdp'); assert.equal(delivered.status,'accepted');
    assert.equal(strictCalls[0].session.id,'one'); assert.equal(strictCalls[0].opts.mode,'submit');
    const refused=value(await call({to:'zcode:one',message:'unavailable',id:'auto-cdp-fail',consent:true}));
    assert.equal(refused.code,'DESKTOP_UNAVAILABLE'); assert.equal(refused.status,'refused');
    assert.equal(inbox.get('auto-cdp-fail').text,'unavailable');
    assert.equal(strictCalls.length,2); assert.equal(calls.length,count);
  } finally {desktop.sendDesktopStrict=original;}
});
