'use strict';
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const home=fs.mkdtempSync(path.join(os.tmpdir(),'openacom-fleet-tests-'));
process.env.AGENTRELAY_HOME=path.join(home,'local');
const {runHub,request}=require('../lib/distributed');
const inbox=require('../lib/inbox');
const fleet=require('../desktop/fleet-api');
const token='fleet-test-only-secret-'.repeat(3);
async function hub(){return runHub({host:'127.0.0.1',port:0,dataDir:fs.mkdtempSync(path.join(home,'hub-')),token});}
const connection=s=>({url:'http://127.0.0.1:'+s.address().port,token});
const close=s=>new Promise(r=>s.close(r));

test('admin queue observation is authenticated, bounded, filterable and never claims messages',async()=>{
 const server=await hub(),conn=connection(server);
 try{
  const reg=await request(conn,'POST','/nodes/test-node/heartbeat',{instanceId:randomUUID(),sessionId:randomUUID(),targets:['agent']});
  const id=randomUUID();await request(conn,'POST','/messages',{id,to:'test-node',target:'agent',text:'x'.repeat(6000)});
  const page=await request(conn,'GET','/admin/messages?node=test-node&status=queued&limit=1');
  assert.equal(page.total,1);assert.equal(page.messages[0].text.length,2000);assert.equal(page.messages[0].truncated,true);assert.equal(page.messages[0].status,'queued');assert.equal(page.messages[0].attempts,0);
  assert.equal((await request(conn,'GET','/messages/'+id)).status,'queued');
  await assert.rejects(request({...conn,token:reg.nodeToken},'GET','/admin/messages'),{status:403});
  await assert.rejects(request({...conn,token:'wrong-token-'.repeat(4)},'GET','/admin/messages'),{status:401});
  await assert.rejects(request(conn,'GET','/admin/messages?limit=201'),{status:400});
  const result=await fleet.handle({action:'fleet.snapshot',...conn});assert.equal(result.messages.length,1);assert.equal(result.nodes[0].id,'test-node');
 }finally{await close(server);}
});

test('inbox listener cursor drains filtered bursts without claiming, changing or dropping rows',()=>{
 let cursor=inbox.watchCursor();
 for(let i=0;i<237;i++)inbox.post({id:'burst-'+i,fromAddr:'pi:sender',toAddr:i%2?'desktop:other':'desktop:operator',text:'message '+i});
 const ids=[];let more;
 do {const page=inbox.watchPage(cursor,{toAddr:'desktop:operator',limit:30});cursor=page.cursor;more=page.more;if(page.rows.length)assert.equal('text' in page.rows[0],false);ids.push(...page.rows.map(row=>row.id));}while(more);
 assert.equal(ids.length,119);assert.equal(new Set(ids).size,119);assert.equal(inbox.watchPage(cursor,{toAddr:'desktop:operator'}).rows.length,0);
 assert.equal(inbox.get(ids[0]).status,'sent');inbox.markRead(ids[0]);assert.equal(inbox.watchPage(cursor).rows.length,0);
});

test('SSH transport pins host keys, stays noninteractive, and cannot inject SSH flags',()=>{
 const args=fleet.sshArgs({host:'example.test',user:'operator',port:19330,sshPort:22,remotePort:9330});
 assert.ok(args.includes('StrictHostKeyChecking=yes'));assert.ok(args.includes('BatchMode=yes'));assert.ok(args.includes('127.0.0.1:19330:127.0.0.1:9330'));
 assert.throws(()=>fleet.sshArgs({host:'-oProxyCommand=anything',user:'operator'}));
 assert.throws(()=>fleet.sshArgs({host:'example.test',user:'operator;bad'}));
});

function remote(req){
 const payload=JSON.stringify({script:fs.readFileSync(path.join(__dirname,'../desktop/remote-agent.js'),'utf8'),request:req});
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['-e',fleet.REMOTE_BOOTSTRAP],{env:{...process.env,USERPROFILE:path.join(home,'remote'),HOME:path.join(home,'remote')},windowsHide:true,stdio:['pipe','pipe','pipe']});let body='',err='';
  const timer=setTimeout(()=>{child.kill();reject(Error('remote fixture timeout '+err));},30000);
  child.stdout.on('data',b=>body+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('close',()=>{clearTimeout(timer);try{const value=JSON.parse(body);if(!value.ok)throw Error(value.error);resolve(value.result);}catch(e){reject(Error(e.message+' '+err));}});child.stdin.end(payload);
 });
}
test('remote deployment protocol installs and controls its own real node without storing the bootstrap token',async()=>{
 const server=await hub(),conn=connection(server),nodeId='managed-node';
 fs.mkdirSync(path.join(home,'remote'),{recursive:true});
 try{
  const probe=await remote({operation:'probe'});assert.equal(probe.home,path.join(home,'remote'));
  const install=await remote({operation:'install',nodeId,files:fleet.deploymentFiles()});assert.equal(install.installed,true);
  await remote({operation:'target.save',nodeId,name:'agent',type:'zcode',value:'fixture-session',port:9222});
  const started=await remote({operation:'start',nodeId,url:conn.url,token});assert.equal(started.state,'running');
  const again=await remote({operation:'start',nodeId,url:conn.url,token});assert.equal(again.alreadyRunning,true);assert.equal(again.pid,started.pid);
  let nodes=[];for(let i=0;i<40;i++){nodes=(await request(conn,'GET','/nodes')).nodes;if(nodes.some(n=>n.id===nodeId))break;await new Promise(r=>setTimeout(r,100));}
  assert.ok(nodes.some(n=>n.id===nodeId&&n.online));
  const log=await remote({operation:'logs',nodeId});assert.ok(!log.text.includes(token));
  const stopped=await remote({operation:'stop',nodeId});assert.equal(stopped.state,'stopped');assert.equal((await remote({operation:'status',nodeId})).state,'stopped');
  await assert.rejects(remote({operation:'install',nodeId:'../outside',files:fleet.deploymentFiles()}),/节点 ID/);
  fs.writeFileSync(path.join(install.directory,'runtime.json'),JSON.stringify({pid:process.pid,nodeId,port:1,nonce:'a'.repeat(64)}));
  assert.equal((await remote({operation:'status',nodeId})).state,'unverified');
  await assert.rejects(remote({operation:'stop',nodeId}),/无法确认进程身份/);
  fs.unlinkSync(path.join(install.directory,'runtime.json'));
 }finally{try{await remote({operation:'stop',nodeId});}catch{}await close(server);}
});

test('background inbox service emits new inbox notifications and can be stopped cleanly',async()=>{
 const child=spawn(process.execPath,[path.join(__dirname,'../desktop/service-host.js')],{env:{...process.env},windowsHide:true,stdio:['pipe','pipe','pipe']});
 let buffer='',events=[],error='';child.stdout.on('data',chunk=>{buffer+=chunk;let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(line)events.push(JSON.parse(line));}});child.stderr.on('data',b=>error+=b);
 const wait=async predicate=>{for(let i=0;i<160;i++){const found=events.find(predicate);if(found)return found;await new Promise(r=>setTimeout(r,50));}throw Error('listener timeout '+error);};
 try{
  child.stdin.write(JSON.stringify({kind:'inbox',receiver:'desktop:listener',pollMs:1000})+'\n');await wait(e=>e.state==='running');
  inbox.post({id:'listener-event',fromAddr:'pi:sender',toAddr:'desktop:listener',text:'background receive'});
  const notice=await wait(e=>e.event==='inbox');assert.equal(notice.count,1);assert.equal(notice.messages[0].id,'listener-event');assert.equal(inbox.get('listener-event').status,'sent');
  child.stdin.write('{"action":"stop"}\n');await wait(e=>e.state==='stopped');
 }finally{child.kill();}
});
after(()=>{inbox.close();fs.rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:150});});
