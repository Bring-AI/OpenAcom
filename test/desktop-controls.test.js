'use strict';
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
const home=fs.mkdtempSync(path.join(os.tmpdir(),'openacom-controls-'));
process.env.AGENTRELAY_HOME=home;
const api=require('../desktop/control-api');
const inbox=require('../lib/inbox');
const sdk=require('../lib/sdk');

test('frontend preferences persist validated fields without a plaintext token',async()=>{
 await api.handle({action:'preferences.save',preferences:{from:'pi:operator',route:'desktopcdp',cdpPort:'9233',timeoutMs:'20000',refreshSeconds:'15',url:'http://127.0.0.1:9330',encryptedToken:'windows-encrypted-data',token:'DO-NOT-PERSIST'}});
 const saved=await api.handle({action:'preferences.get'});assert.equal(saved.cdpPort,9233);assert.equal(saved.route,'desktopcdp');assert.equal(saved.token,undefined);
 assert.ok(!fs.readFileSync(path.join(home,'desktop-preferences.json'),'utf8').includes('DO-NOT-PERSIST'));
 await assert.rejects(api.handle({action:'preferences.save',preferences:{route:'invalid'}}));
});
test('all send controls reach the SDK options with mailbox and route restrictions',()=>{
 const opts=api.sendOptions({to:'zcode:one',from:'desktop:custom',id:'one',route:'auto',cdpPort:'9233',cdpTargetId:'page1',timeoutMs:'10000',noSignature:true,consent:true});
 assert.equal(opts.from,'desktop:custom');assert.equal(opts.cdpPort,9233);assert.equal(opts.cdpTargetId,'page1');assert.equal(api.sendOptions({to:'codex:one',route:'session',wait:true}).wait,true);assert.throws(()=>api.sendOptions({to:'zcode:one',wait:true}));assert.equal(opts.noSignature,true);
 assert.equal(api.sendOptions({route:'mailbox',consent:true}).consent,undefined);
 assert.throws(()=>api.sendOptions({to:'zcode:one',cdpPort:999999}));
});
test('message detail uses the full stored body and uncertain retries need explicit verification',async()=>{
 inbox.create({id:'original',fromAddr:'pi:one',toAddr:'qoder:one',agent:'qoder',sessionId:'one',text:'文'.repeat(5000),maxAttempts:1});inbox.setFields('original',{status:'uncertain',delivery:'session'});
 assert.equal((await api.handle({action:'message.get',id:'original'})).text.length,5000);
 await assert.rejects(api.handle({action:'message.retry',originalId:'original',id:'retry',route:'mailbox'}),/核实/);
 const result=await api.handle({action:'message.retry',originalId:'original',id:'retry',route:'mailbox',verified:true});
 assert.equal(result.status,'stored');assert.equal(result.retryOf,'original');assert.equal(inbox.get('retry').text.length,5000);
 assert.equal(inbox.get('original').status,'uncertain');
 inbox.post({id:'legacy-mail',fromAddr:'pi:old',toAddr:'qoder:one',text:'old inbox'});
 assert.equal((await api.handle({action:'message.retry',originalId:'legacy-mail',id:'legacy-retry',route:'mailbox'})).status,'stored');
 assert.equal((await api.handle({action:'message.retry',originalId:'original',id:'retry',route:'mailbox',verified:true})).replayed,true);
});
test('configuration forms save targets, groups and hooks and validate before replacing files',async()=>{
 await api.handle({action:'config.save',kind:'targets',rows:[{name:'desktop',type:'zcode',value:'session-one',extra:'9233'}]});
 const rows=(await api.handle({action:'config.get',kind:'targets'})).rows;assert.equal(rows[0].extra,'9233');
 await assert.rejects(api.handle({action:'config.save',kind:'targets',rows:[{name:'bad',type:'zcode',value:'session-one',extra:'99999'}]}));
 assert.equal((await api.handle({action:'config.get',kind:'targets'})).rows[0].name,'desktop');
 await api.handle({action:'config.save',kind:'groups',rows:[{type:'group',name:'team',value:'codex, pi'},{type:'owner',name:'platform:codex',value:'codex'}]});
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home,'groups.json'),'utf8')).groups.team,['codex','pi']);
 const disabled=await api.handle({action:'groups.disable'});assert.equal(disabled.disabled,true);assert.equal(fs.existsSync(path.join(home,'groups.json')),false);assert.ok(fs.existsSync(disabled.backup));
 await api.handle({action:'config.save',kind:'hooks',rows:[{name:'message.read',value:'openacom-hook-test-must-not-run'}]});
 assert.equal((await api.handle({action:'config.get',kind:'hooks'})).rows.length,1);
 await api.handle({action:'config.save',kind:'hooks',rows:[]});
});
test('session reader calls the existing SDK and returns bounded transcript text',async()=>{
 const original=sdk.readSession;let seen;
 sdk.readSession=(id,opts)=>{seen={id,opts};return [{role:'assistant',text:'x'.repeat(20000)}];};
 try{const result=await api.handle({action:'session.read',address:'pi:session',last:5});assert.equal(seen.id,'session');assert.equal(seen.opts.agent,'pi');assert.ok(result.text.length<8100);}finally{sdk.readSession=original;}
});
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
async function launch(config){
 const child=spawn(process.execPath,[path.join(__dirname,'../desktop/service-host.js')],{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,AGENTRELAY_HOME:path.join(home,config.kind)}});
 let buffer='',stderr='',events=[];child.stderr.on('data',b=>stderr+=b);child.stdout.on('data',b=>{buffer+=b;let newline;while((newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);if(line)events.push(JSON.parse(line));}});
 child.stdin.write(JSON.stringify(config)+'\n');
 const wait=async state=>{const limit=Date.now()+15000;while(Date.now()<limit){const result=events.find(e=>e.state===state||e.state==='failed');if(result)return result;await new Promise(r=>setTimeout(r,30));}throw new Error('service timeout '+stderr);};
 return {child,wait,stderr:()=>stderr};
}
test('frontend can start and gracefully stop real Hub and MCP HTTP services',async()=>{
 for(const kind of ['hub','mcp']){
  const port=await freePort(),token='frontend-service-secret-'.repeat(3);const service=await launch({kind,port,token});
  try{
   const ready=await service.wait('running');assert.equal(ready.state,'running',JSON.stringify(ready));
   const response=await fetch(`http://127.0.0.1:${port}/${kind==='hub'?'nodes':'health'}`,{headers:{Authorization:'Bearer '+token}});assert.equal(response.status,200);
   assert.ok(!service.stderr().includes(token));
   service.child.stdin.write('{"action":"stop"}\n');assert.equal((await service.wait('stopped')).state,'stopped');
  }finally{service.child.kill();}
 }
});
after(()=>{inbox.close();fs.rmSync(home,{recursive:true,force:true,maxRetries:8,retryDelay:100});});
