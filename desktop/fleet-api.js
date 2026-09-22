'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),net=require('node:net');
const {spawn}=require('node:child_process');
const lib=fs.existsSync(path.join(__dirname,'lib/sdk.js'))?'./lib/':'../lib/';
const {root,port}=require('./control-api');
const {request}=require(lib+'distributed');
const fail=message=>Object.assign(new Error(message),{code:'INVALID_ARGUMENT',uncertain:false});
const knownHosts=()=>path.join(root(),'desktop-known-hosts');
function host(value){if(typeof value!=='string'||value.length>253||!value||!/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(value))throw fail('主机名或 IP 无效');return value;}
function sshTool(name){const exe=path.join(process.env.WINDIR||'C:/Windows','System32','OpenSSH',name+'.exe');return process.platform==='win32'&&fs.existsSync(exe)?exe:name;}
function sshArgs(config){
 const server=host(config.host),remoteHost=host(config.remoteHost||'127.0.0.1');
 if(typeof config.user!=='string'||!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(config.user))throw fail('SSH 用户名无效');
 const local=port(config.port,19330),remote=port(config.remotePort,9330),sshPort=port(config.sshPort,22);
 const args=['-N','-T','-p',String(sshPort),'-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=8','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+knownHosts(),'-L',`127.0.0.1:${local}:${remoteHost.includes(':')?'['+remoteHost+']':remoteHost}:${remote}`];
 if(config.identity){if(!fs.statSync(config.identity).isFile())throw fail('请选择 SSH 私钥文件');args.push('-i',config.identity);}
 args.push(config.user+'@'+server);return args;
}
async function keyScan(config){
 const server=host(config.host),number=port(config.sshPort,22);
 const args=['-T','5','-p',String(number),'-t','ed25519,ecdsa,rsa',server];
 const output=await new Promise((resolve,reject)=>{
  const child=spawn(sshTool('ssh-keyscan'),args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let data='',error='';
  const timer=setTimeout(()=>{child.kill();reject(fail('SSH 主机指纹探测超时'));},8000);
  child.stdout.on('data',chunk=>{data+=chunk;if(data.length>65536){child.kill();reject(fail('SSH 指纹响应过大'));}});child.stderr.on('data',chunk=>{if(error.length<1000)error+=chunk;});
  child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);if(code!==0||!data.trim())reject(fail('无法读取 SSH 主机指纹：'+error.slice(0,300)));else resolve(data);});
 });
 const keys=[];
 for(const line of output.split(/\r?\n/)){
  const parts=line.trim().split(/\s+/);if(parts.length!==3||line.startsWith('#'))continue;
  const algorithm=parts[1],key=parts[2];if(!/^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa)$/.test(algorithm)||!/^[A-Za-z0-9+/]+={0,2}$/.test(key))continue;
  const address=number===22?server:`[${server}]:${number}`;
  keys.push({line:`${address} ${algorithm} ${key}`,fingerprint:'SHA256:'+crypto.createHash('sha256').update(Buffer.from(key,'base64')).digest('base64').replace(/=+$/,''),algorithm});
 }
 if(!keys.length)throw fail('未取得有效的 SSH 主机指纹');return {host:server,sshPort:number,keys};
}
async function handle(req){
 if(req.action==='remote.execute')return remoteRequest(req);
 if(req.action==='fleet.profiles.get'||req.action==='fleet.profiles.save'){
   const file=path.join(root(),'desktop-machines.json');let profiles={};try{profiles=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw fail('机器配置文件无法读取');}
   if(req.action==='fleet.profiles.get')return {profiles:Object.values(profiles)};
   const input=req.profile||{},profile={};for(const key of ['host','user','sshPort','identity','port','remotePort','remoteHost','nodeId','remoteUrl'])profile[key]=String(input[key]||'');
   sshArgs(profile);if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile.nodeId))throw fail('节点 ID 无效');
   const id=crypto.createHash('sha256').update(profile.user+'@'+profile.host+'/'+profile.nodeId).digest('hex').slice(0,24);profiles[id]=profile;if(Object.keys(profiles).length>64)throw fail('最多保存 64 台机器');
   fs.mkdirSync(root(),{recursive:true,mode:0o700});const secure=require(lib+'secure-fs');secure.protectPath(root(),{directory:true});const tmp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(profiles,null,2),{mode:0o600});secure.protectPath(tmp);fs.renameSync(tmp,file);secure.protectPath(file);return {saved:true};
 }
 const connection={url:req.url,token:req.token,timeoutMs:10000};
 if(req.action==='fleet.snapshot'){
   const nodes=await request(connection,'GET','/nodes');
   const query=new URLSearchParams({limit:'200'});if(req.node)query.set('node',req.node);if(req.status)query.set('status',req.status);
   const results=await Promise.allSettled([request(connection,'GET','/admin/messages?'+query),request(connection,'GET','/security')]);
   let listing,warning='';
   if(results[0].status==='fulfilled')listing=results[0].value;
   else if(results[0].reason.status===404){listing={messages:[],counts:{},total:0};warning='此 Hub 版本没有管理队列接口，请升级 Hub；节点信息仍可查看。';}
   else throw results[0].reason;
   if(results[1].status==='rejected')warning+=(warning?' ':'')+'安全事件暂不可读。';
   return {...nodes,messages:listing.messages,counts:listing.counts,total:listing.total,alerts:results[1].status==='fulfilled'?results[1].value.alerts:[],warning,queueAvailable:results[0].status==='fulfilled'};
 }
 if(req.action==='fleet.message')return request(connection,'GET','/messages/'+encodeURIComponent(req.id));
 if(req.action==='fleet.retry')return request(connection,'POST','/messages/'+encodeURIComponent(req.id)+'/retry',{});
 if(req.action==='fleet.prune')return request(connection,'POST','/queue/prune',{});
 if(req.action==='ssh.scan')return keyScan(req);
 if(req.action==='ssh.trust'){
   const scan=await keyScan(req);
   if(!Array.isArray(req.fingerprints)||!scan.keys.length||scan.keys.some(k=>!req.fingerprints.includes(k.fingerprint)))throw fail('主机指纹已变化，请重新检查并确认');
   fs.mkdirSync(root(),{recursive:true,mode:0o700});const secure=require(lib+'secure-fs');secure.protectPath(root(),{directory:true});
   const filename=knownHosts();const target=scan.sshPort===22?scan.host:`[${scan.host}]:${scan.sshPort}`;
   let lines=[];try{lines=fs.readFileSync(filename,'utf8').split(/\r?\n/).filter(line=>line&&!line.startsWith(target+' '));}catch(e){if(e.code!=='ENOENT')throw e;}
   fs.writeFileSync(filename,lines.concat(scan.keys.map(k=>k.line)).join('\n')+'\n',{mode:0o600});secure.protectPath(filename);return {trusted:true,host:scan.host};
 }
 throw fail('未知分布式操作');
}
module.exports={handle,sshArgs,sshTool,knownHosts};

const REMOTE_BOOTSTRAP="let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>{b+=d;if(b.length>9000000)process.exit(2)});process.stdin.on('end',()=>{const p=JSON.parse(b),m={exports:{}};new Function('require','module','process',p.script)(require,m,process);m.exports.run(p.request).then(result=>process.stdout.write(JSON.stringify({ok:true,result})),e=>{process.stdout.write(JSON.stringify({ok:false,error:e.message,code:e.code||'REMOTE_ERROR'}));process.exitCode=1})})";
function deploymentFiles(){
 const base=fs.existsSync(path.join(__dirname,'lib/distributed.js'))?__dirname:path.dirname(__dirname),files=[];
 function walk(relative){for(const item of fs.readdirSync(path.join(base,relative),{withFileTypes:true})){const name=relative+'/'+item.name;if(item.isDirectory())walk(name);else if(item.isFile()&&/\.(js|ps1|html)$/.test(name))files.push({name,data:fs.readFileSync(path.join(base,name)).toString('base64')});}}
 walk('lib');walk('tools');files.push({name:'package.json',data:fs.readFileSync(path.join(base,'package.json')).toString('base64')});files.push({name:'worker.cjs',data:fs.readFileSync(path.join(__dirname,'remote-node-worker.js')).toString('base64')});return files;
}
async function remoteRequest(req){
 const operations=['probe','install','status','start','stop','logs','targets.get','target.save','target.remove'];
 if(!operations.includes(req.operation))throw fail('远端操作无效');
 // Reuse strict host/key validation, omitting tunnel-specific options for a command.
 const args=sshArgs({...req,port:19330,remotePort:9330});args.splice(args.indexOf('-L'),2);args.splice(args.indexOf('-N'),1);
 args.push('node -e "'+REMOTE_BOOTSTRAP+'"');
 const request={operation:req.operation,nodeId:req.nodeId,url:req.remoteUrl,token:req.operation==='start'?req.token:undefined,name:req.name,type:req.type,value:req.value,port:req.cdpPort};
 if(req.operation==='install')request.files=deploymentFiles();
 const script=fs.readFileSync(path.join(__dirname,'remote-agent.js'),'utf8');
 return new Promise((resolve,reject)=>{
  const child=spawn(sshTool('ssh'),args,{windowsHide:true,stdio:['pipe','pipe','pipe']});let output='',errors='',settled=false;
  const done=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(result);};
  const timer=setTimeout(()=>{child.kill();done(fail('SSH 操作超时。请先查询远端状态，不要直接重复启动。'));},60000);
  child.stdout.on('data',chunk=>{output+=chunk;if(output.length>1500000){child.kill();done(fail('远端响应超过限制'));}});child.stderr.on('data',chunk=>{if(errors.length<4000)errors+=chunk;});
  child.on('error',error=>done(error));child.stdin.on('error',error=>done(error));
  child.on('close',code=>{if(settled)return;try{const r=JSON.parse(output);if(!r.ok)throw fail(r.error);done(null,r.result);}catch(e){done(fail(output?e.message:'SSH 连接或远端 Node.js 执行失败：'+errors.slice(0,1200)));}});
  child.stdin.end(JSON.stringify({script,request}));
 });
}
module.exports.remoteRequest=remoteRequest;
module.exports.deploymentFiles=deploymentFiles;
module.exports.REMOTE_BOOTSTRAP=REMOTE_BOOTSTRAP;
