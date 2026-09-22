'use strict';
// Runs on the selected SSH host. All mutable files are under the user's owned node slot.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),http=require('node:http');
const {spawn}=require('node:child_process');
function fail(message){throw Object.assign(new Error(message),{code:'REMOTE_CONTROL_REFUSED'});}
function owned(req){
 if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(req.nodeId||'')||req.nodeId==='..')fail('节点 ID 无效');
 const base=path.join(os.homedir(),'.openacom','desktop-managed');
 const slot=path.join(base,req.nodeId);fs.mkdirSync(slot,{recursive:true,mode:0o700});
 if(fs.lstatSync(slot).isSymbolicLink())fail('托管目录不能是符号链接');
 return slot;
}
function lock(slot){
 const file=path.join(slot,'operation.lock');
 if(fs.existsSync(file)){const previous=JSON.parse(fs.readFileSync(file,'utf8'));let alive=true;try{process.kill(previous.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}if(alive)fail('另一个节点操作正在执行');fs.unlinkSync(file);}
 const nonce=crypto.randomUUID();fs.writeFileSync(file,JSON.stringify({pid:process.pid,nonce}),{flag:'wx',mode:0o600});
 return ()=>{try{if(JSON.parse(fs.readFileSync(file,'utf8')).nonce===nonce)fs.unlinkSync(file);}catch{}};
}
const load=(file,fallback)=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
function save(file,data){const tmp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(data,null,2),{mode:0o600});fs.renameSync(tmp,file);}
function api(runtime,method,route){return new Promise((resolve,reject)=>{
 const req=http.request({host:'127.0.0.1',port:runtime.port,path:route,method,headers:{Authorization:'Bearer '+runtime.nonce},timeout:2500},res=>{let body='';res.on('data',b=>{body+=b;if(body.length>65536)req.destroy(Error('响应过大'));});res.on('end',()=>{try{if(res.statusCode!==200)throw Error('进程身份验证失败');const r=JSON.parse(body);if(r.pid!==runtime.pid||r.nodeId!==runtime.nodeId)throw Error('进程身份不匹配');resolve(r);}catch(e){reject(e);}});});req.on('timeout',()=>req.destroy(Error('控制端口超时')));req.on('error',reject);req.end();
});}
async function status(slot){
 const runtime=load(path.join(slot,'runtime.json'),null);if(!runtime)return {state:'stopped'};
 if(runtime.nodeId!==path.basename(slot))fail('进程记录不属于这个节点，不会操作');
 if(!Number.isInteger(runtime.port)||runtime.port<1||runtime.port>65535||!Number.isInteger(runtime.pid)||runtime.pid<=0||!/^[a-f0-9]{64}$/.test(runtime.nonce))fail('托管进程记录无效');
 try{return await api(runtime,'GET','/status');}catch(error){
   let alive=true;try{process.kill(runtime.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}
   return {state:alive?'unverified':'stopped',pid:runtime.pid,detail:alive?'无法确认进程身份；不会按 PID 强行停止':error.message};
 }
}
async function run(req){
 const major=Number(process.versions.node.split('.')[0]),minor=Number(process.versions.node.split('.')[1]);
 if(major<22||(major===22&&minor<5))fail('远端需要 Node.js 22.5 或更高版本');
 if(req.operation==='probe')return {node:process.version,platform:process.platform,arch:process.arch,home:os.homedir()};
 const slot=owned(req),currentFile=path.join(slot,'current.json');
 if(req.operation==='status')return {...await status(slot),deployed:!!load(currentFile,null),installedVersion:load(currentFile,{}).version,directory:slot};
 if(req.operation==='install'){
   if(!Array.isArray(req.files)||req.files.length>160)fail('部署文件列表无效');
   const hash=crypto.createHash('sha256');let size=0;
   for(const file of req.files){if(!/^(package\.json|lib\/[A-Za-z0-9_./-]+|tools\/[A-Za-z0-9_.-]+|worker\.cjs)$/.test(file.name)||file.name.split('/').includes('..'))fail('部署路径无效');const bytes=Buffer.from(file.data,'base64');size+=bytes.length;if(size>6000000)fail('部署包过大');hash.update(file.name).update(bytes);}
   const digest=hash.digest('hex'),release=path.join(slot,'releases',digest);
   const unlock=lock(slot);
   try {
   if(!fs.existsSync(path.join(release,'.complete'))){
     const staging=path.join(slot,'releases','.staging-'+crypto.randomUUID());fs.mkdirSync(staging,{recursive:true,mode:0o700});
     for(const file of req.files){const target=path.join(staging,...file.name.split('/'));fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});fs.writeFileSync(target,Buffer.from(file.data,'base64'),{mode:0o600});}
     if(!fs.existsSync(path.join(staging,'lib/distributed.js'))||!fs.existsSync(path.join(staging,'worker.cjs')))fail('部署包不完整');
     fs.writeFileSync(path.join(staging,'.complete'),digest,{mode:0o600});
     if(fs.existsSync(release))fs.renameSync(release,release+'.incomplete-'+crypto.randomUUID());fs.renameSync(staging,release);
   }
   if(!fs.existsSync(path.join(release,'lib','distributed.js'))||!fs.existsSync(path.join(release,'worker.cjs')))fail('部署包不完整');
   const secure=require(path.join(release,'lib','secure-fs.js'));secure.protectPath(slot,{directory:true});secure.protectPath(release,{directory:true});
   save(currentFile,{release:digest,version:load(path.join(release,'package.json'),{}).version});secure.protectPath(currentFile);
   return {installed:true,version:load(currentFile,{}).version,directory:slot,restartRequired:(await status(slot)).state==='running'};
   }finally{unlock();}
 }
 const current=load(currentFile,null);if(!current||!/^[a-f0-9]{64}$/.test(current.release))fail('请先部署节点');
 const release=path.join(slot,'releases',current.release),targetFile=path.join(slot,'targets.json');
 if(req.operation==='targets.get'){
   const targets=load(targetFile,{});const dir=path.join(os.homedir(),'.openacom','terminals');let descriptors=[];try{descriptors=fs.readdirSync(dir).filter(n=>/^[A-Za-z0-9._-]+\.json$/.test(n)).slice(0,128);}catch{}
   return {targets:Object.entries(targets).map(([name,t])=>({name,type:t.type,value:t.sessionId||'',port:t.cdpPort||9222})),descriptors};
 }
 if(req.operation==='target.save'){
   if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(req.name||''))fail('目标名称无效');
   let target;
   if(req.type==='terminal'){
     if(!/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(req.value||''))fail('请选择该机器的终端描述文件');
     target=load(path.join(os.homedir(),'.openacom','terminals',req.value),null);
   }else if(req.type==='zcode')target={type:'zcode',sessionId:req.value,cdpPort:Number(req.port)||9222};else fail('目标类型无效');
   require(path.join(release,'lib','delivery.js')).validateTarget(target);
   const targets=load(targetFile,{});targets[req.name]=target;save(targetFile,targets);require(path.join(release,'lib','secure-fs.js')).protectPath(targetFile);return {saved:true,restartRequired:true};
 }
 if(req.operation==='target.remove'){
   const targets=load(targetFile,{});if(!Object.hasOwn(targets,req.name))fail('目标不存在');delete targets[req.name];save(targetFile,targets);require(path.join(release,'lib','secure-fs.js')).protectPath(targetFile);return {removed:true,restartRequired:true};
 }
 if(req.operation==='logs'){
   const file=path.join(slot,'node.log');if(!fs.existsSync(file))return {text:'暂无日志'};
   const fd=fs.openSync(file,'r');try{const length=fs.fstatSync(fd).size,size=Math.min(length,32000),buffer=Buffer.alloc(size);fs.readSync(fd,buffer,0,size,length-size);return {text:buffer.toString('utf8')};}finally{fs.closeSync(fd);}
 }
 if(req.operation==='stop'){
   const state=await status(slot);if(state.state==='stopped')return state;if(state.state==='unverified')fail(state.detail);
   const runtime=load(path.join(slot,'runtime.json'),null);await api(runtime,'POST','/stop');
   for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,250));if((await status(slot)).state==='stopped')return {state:'stopped'};}
   return {state:'stopping',detail:'正在等待当前操作结束；请刷新状态'};
 }
 if(req.operation==='start'){
   const unlock=lock(slot);try{
   const state=await status(slot);if(state.state==='running')return {...state,alreadyRunning:true};if(state.state==='unverified')fail(state.detail);
   if(!fs.existsSync(targetFile)||!Object.keys(load(targetFile,{})).length)fail('请先配置至少一个远端目标');
   if(typeof req.url!=='string'||!/^https?:\/\//.test(req.url))fail('Hub 地址无效');
   if(!req.token||! /^[\x21-\x7e]{32,4096}$/.test(req.token))fail('需要有效的 Hub 注册令牌');
   const log=fs.openSync(path.join(slot,'node.log'),'a',0o600);
   const child=spawn(process.execPath,['--experimental-sqlite',path.join(release,'worker.cjs'),slot,req.nodeId,req.url],{detached:true,windowsHide:true,stdio:['pipe',log,log],cwd:release});fs.closeSync(log);
   await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.stdin.end(JSON.stringify({token:req.token}));child.unref();
   for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,250));const active=await status(slot);if(active.state==='running')return active;if(child.exitCode!==null)break;}
   return {state:'starting',detail:'进程启动尚未确认，请检查状态和日志'};
   }finally{unlock();}
 }
 fail('不支持的远端操作');
}
if(require.main===module){let body='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{body+=chunk;if(body.length>9000000)process.exit(2);});process.stdin.on('end',async()=>{try{process.stdout.write(JSON.stringify({ok:true,result:await run(JSON.parse(body))}));}catch(e){process.stdout.write(JSON.stringify({ok:false,error:e.message,code:e.code||'REMOTE_ERROR'}));process.exitCode=1;}});}
module.exports={run,status};
