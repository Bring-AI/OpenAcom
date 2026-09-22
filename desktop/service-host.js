'use strict';
// Long-lived, parent-owned services. Configuration arrives over stdin, never argv.
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const lib=fs.existsSync(path.join(__dirname,'lib/sdk.js'))?'./lib/':'../lib/';
const {root,port}=require('./control-api');
let inboxTimer;
let server,child,nodeTask,started=false,stopping=false,secrets=[];
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
const scrub=text=>secrets.reduce((out,secret)=>secret?out.split(secret).join('[redacted]'):out,String(text));
const oldWrite=process.stderr.write.bind(process.stderr);
process.stderr.write=(chunk,...args)=>oldWrite(scrub(chunk),...args);
async function stop(){
 if(stopping)return;stopping=true;if(inboxTimer){clearInterval(inboxTimer);require(lib+'inbox').close();}process.emit('SIGTERM');
 if(child){try{child.kill();}catch{}}
 if(server)await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections?.();});
 if(nodeTask)await nodeTask.catch(()=>{});
 emit({state:'stopped'});process.exit(0);
}
async function start(config){
 if(started)throw Error('Service already started');started=true;
 if(!['hub','node','mcp','web','opencode','ssh','inbox'].includes(config.kind))throw Error('Unknown service');
 const dataDir=path.join(root(),'desktop-services');
 secrets=[config.token||''];
 const number=config.kind==='inbox'?0:port(config.port,{hub:9330,mcp:9321,web:9339,opencode:4096,node:9330,ssh:19330}[config.kind]);
 if(config.kind==='inbox'){
   const inbox=require(lib+'inbox'),receiver=config.receiver==='*'||!config.receiver?undefined:config.receiver;
   if(receiver&&!/^[A-Za-z][A-Za-z0-9_.-]*:\S+$/.test(receiver))throw Error('收件地址格式无效');
   const interval=Number(config.pollMs)||2000;if(!Number.isInteger(interval)||interval<1000||interval>60000)throw Error('监听间隔必须为 1–60 秒');
   let cursor=config.includeExisting===true?0:inbox.watchCursor();
   const poll=()=>{try{const page=inbox.watchPage(cursor,{toAddr:receiver,limit:100});cursor=page.cursor;const rows=page.rows.filter(r=>r.status!=='read');if(rows.length)emit({event:'inbox',count:rows.length,messages:rows.map(r=>({id:r.id,from:r.from_addr,to:r.to_addr,status:r.status})),cursor});}catch(error){emit({state:'failed',error:error.message});stop();}};
   inboxTimer=setInterval(poll,interval);if(config.includeExisting)poll();
 }
 if(config.kind==='hub')server=await require(lib+'distributed').runHub({host:'127.0.0.1',port:number,dataDir,token:config.token});
 if(config.kind==='web' && !/^[\x21-\x7e]{32,4096}$/.test(config.token||''))throw Error('请在连接设置填写或生成访问令牌，再启动 Web 服务');
 if(config.kind==='web')server=await require(lib+'web').startWeb(number,{open:false,token:config.token});
 if(config.kind==='mcp'){
   server=require(lib+'mcp-http').runHttp(number);
   await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
 }
 if(config.kind==='node'){
   nodeTask=require(lib+'distributed').runNode({url:config.url,token:config.token,nodeId:config.nodeId,dataDir,targetsFile:path.join(root(),'desktop-targets.json')});
   nodeTask.then(()=>{if(!stopping){emit({state:'stopped'});process.exit(0);}}).catch(error=>{emit({state:'failed',error:scrub(error.message)});process.exit(1);});
 }
 if(config.kind==='ssh'){
   const fleet=require('./fleet-api');
   child=require('node:child_process').spawn(fleet.sshTool('ssh'),fleet.sshArgs(config),{windowsHide:true,stdio:['ignore','ignore','pipe']});
   child.stderr.on('data',data=>process.stderr.write(data));
   await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
   child.on('exit',code=>{if(!stopping){emit({state:'failed',error:'SSH 隧道已断开',code});process.exit(code||1);}});
   const deadline=Date.now()+10000;let ready=false;
   while(Date.now()<deadline && child.exitCode===null){ready=await new Promise(resolve=>{const socket=require('node:net').connect(number,'127.0.0.1');socket.setTimeout(300);socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));socket.once('timeout',()=>{socket.destroy();resolve(false);});});if(ready)break;await new Promise(r=>setTimeout(r,150));}
   if(!ready){child.kill();throw Error('SSH 隧道没有就绪，请检查指纹、私钥与日志');}
 }
 if(config.kind==='opencode'){
   const exe=require(lib+'adapters/opencode').cliPath();if(!exe||exe==='opencode')throw Error('OpenCode executable not found');
   child=require('node:child_process').spawn(exe,['serve','--hostname','127.0.0.1','--port',String(number)],{cwd:config.cwd||process.cwd(),windowsHide:true,stdio:['ignore','ignore','pipe']});
   await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
   child.stderr.on('data',data=>process.stderr.write(data));child.on('exit',code=>{if(!stopping){emit({state:'stopped',code});process.exit(code||0);}});
 }
 emit({state:'running',kind:config.kind,port:number,pid:process.pid,note:config.kind==='node'?'节点进程已启动；注册与联网状态请查看日志':'服务已启动'});
}
const lines=readline.createInterface({input:process.stdin});
lines.on('line',async line=>{
 try{const req=JSON.parse(line);if(req.action==='stop')await stop();else await start(req);}
 catch(error){emit({state:'failed',error:scrub(error.message)});process.exit(1);}
});
lines.on('close',()=>stop().catch(()=>process.exit(1)));
