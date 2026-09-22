'use strict';
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const home=fs.mkdtempSync(path.join(os.tmpdir(),'openacom-desktop-bridge-'));
process.env.AGENTRELAY_HOME=home;
const bridge=path.join(__dirname,'../desktop/bridge.js');
function call(request){
 const result=spawnSync(process.execPath,[bridge],{input:JSON.stringify(request),encoding:'utf8',env:{...process.env},windowsHide:true});
 assert.ok(result.stdout,result.stderr);
 return JSON.parse(result.stdout);
}
test('desktop bridge persists UTF-8 mailbox messages and stable IDs without a Hub',()=>{
 const request={action:'send',to:'qoder:desktop-test',text:'你好，消息\n第二行',id:'desktop-request',route:'mailbox',consent:false};
 const first=call(request);assert.equal(first.ok,true);assert.equal(first.result.status,'stored');
 assert.equal(call(request).result.replayed,true);
 const conflict=call({...request,text:'different'});assert.equal(conflict.ok,false);assert.equal(conflict.code,'ID_CONFLICT');
 const ack=call({action:'ack',id:request.id});assert.equal(ack.result.status,'read');
});
test('desktop default attempts delivery and retains unsupported targets',()=>{
 const result=call({action:'send',to:'unknown:desktop-test',text:'retained',id:'unsupported',route:'auto'});
 assert.equal(result.ok,true);assert.equal(result.result.status,'refused');assert.equal(result.result.code,'INJECT_UNSUPPORTED');
});
test('desktop snapshots use bounded previews and session destinations',async()=>{
 const sdk=require('../lib/sdk');const original=sdk.listSessions;
 sdk.listSessions=()=>[{agent:'zcode',id:'test',title:'测试会话'}];
 const inbox=require('../lib/inbox');
 try {
   inbox.post({id:'long',fromAddr:'pi:test',toAddr:'qoder:test',text:'文'.repeat(10000)});
   const result=await require('../desktop/bridge').execute({action:'snapshot'});
   assert.equal(result.sessions[0].id,'zcode:test');
   assert.equal(result.messages.find(r=>r.id==='long').text.length,2000);
   assert.equal(result.messages.find(r=>r.id==='unsupported').status,'refused');
 }finally{sdk.listSessions=original;inbox.close();}
});
after(()=>{require('../lib/inbox').close();fs.rmSync(home,{recursive:true,force:true,maxRetries:8,retryDelay:100});});

test('session projects normalize Windows aliases but keep same-named directories separate',async()=>{
 const sdk=require('../lib/sdk'),original=sdk.listSessions;
 sdk.listSessions=()=>[
  {id:'a',agent:'zcode',title:'A',workspace:'C:\\Work\\Project'},
  {id:'b',agent:'codex',title:'B',workspace:'c:/work/project/'},
  {id:'c',agent:'claude',title:'C',workspace:'D:/Other/Project'},
  {id:'d',agent:'codex',title:'D'},
 ];
 try {
  const {sessions}=await require('../desktop/bridge').execute({action:'snapshot'});
  assert.equal(sessions[0].projectKey,sessions[1].projectKey);
  assert.notEqual(sessions[0].projectKey,sessions[2].projectKey);
  assert.equal(sessions[0].workspace,'C:/Work/Project');
  assert.equal(sessions[0].projectLabel,'Project');
  assert.equal(sessions[2].agent,'claude');
  assert.equal(sessions[3].projectLabel,'未标注项目');
  assert.equal(sessions[0].id,'zcode:a');
 }finally{sdk.listSessions=original;}
});

test('remote groups are scoped to the node and never guess an agent type from a machine name',async()=>{
 const sdk=require('../lib/sdk'),original=sdk.relayNodes;
 sdk.relayNodes=async()=>({nodes:[
  {id:'zcode-build-machine',online:true,targets:['worker']},
  {id:'machine-a',online:true,targets:[{name:'coder',agent:'codex',workspace:'/work/project'}]},
  {id:'machine-b',online:false,targets:[{name:'coder',agent:'codex',workspace:'/work/project'}]},
 ]});
 try {
  const {sessions}=await require('../desktop/bridge').execute({action:'snapshot',remote:true});
  assert.equal(sessions[0].agent,'unknown');
  assert.equal(sessions[0].id,'node:zcode-build-machine/worker');
  assert.equal(sessions[1].agent,'codex');
  assert.notEqual(sessions[1].projectKey,sessions[2].projectKey);
  assert.equal(sessions[2].status,'离线');
 }finally{sdk.relayNodes=original;}
});

test('saving the session view preserves all other desktop preferences',async()=>{
 const api=require('../desktop/control-api');
 await api.handle({action:'preferences.save',preferences:{from:'pi:viewer',route:'desktopcdp',cdpPort:9233,encryptedToken:'opaque-encrypted-token'}});
 await api.handle({action:'preferences.sessionView',mode:'agent'});
 const prefs=await api.handle({action:'preferences.get'});
 assert.equal(prefs.sessionView,'agent');assert.equal(prefs.cdpPort,9233);assert.equal(prefs.encryptedToken,'opaque-encrypted-token');
 await assert.rejects(api.handle({action:'preferences.sessionView',mode:'invalid'}));
});
