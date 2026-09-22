'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const lib=fs.existsSync(path.join(__dirname,'lib/sdk.js'))?'./lib/':'../lib/';
const sdk=require(lib+'sdk'),inbox=require(lib+'inbox');
const root=()=>process.env.AGENTRELAY_HOME||path.join(os.homedir(),'.openacom');
const fail=(message)=>Object.assign(new Error(message),{code:'INVALID_ARGUMENT',uncertain:false});
function read(file,fallback={}){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw fail('配置文件无法读取，请先修复：'+path.basename(file));}}
function write(file,value){
 const secure=require(lib+'secure-fs');fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});secure.protectPath(path.dirname(file),{directory:true});
 const serialized=JSON.stringify(value,null,2)+'\n';if(Buffer.byteLength(serialized)>262144)throw fail('配置超过 256KB，未保存');
 const tmp=file+'.'+crypto.randomUUID()+'.tmp';
 try{fs.writeFileSync(tmp,serialized,{mode:0o600});secure.protectPath(tmp);fs.renameSync(tmp,file);secure.protectPath(file);}finally{try{fs.unlinkSync(tmp);}catch{}}
 return {saved:true,file};
}
function port(value,fallback){const n=value===''||value==null?fallback:Number(value);if(!Number.isInteger(n)||n<1||n>65535)throw fail('端口必须为 1–65535');return n;}
function sendOptions(req){
 const opts={from:req.from||'desktop:operator',id:req.id,route:req.route||'auto'};
 if(opts.route!=='mailbox'&&req.consent===true)opts.consent=true;
 if(req.remote){opts.url=req.url;opts.token=req.token;}
 if(req.timeoutMs!=null&&req.timeoutMs!==''){const n=Number(req.timeoutMs);if(!Number.isInteger(n)||n<1000||n>300000)throw fail('超时必须为 1000–300000 毫秒');opts.timeoutMs=n;}
 if(req.wait===true){const effective=opts.route==='auto'?(String(req.to).startsWith('node:')?'relay':String(req.to).startsWith('zcode:')?'desktopcdp':'session'):opts.route;if(effective!=='session')throw fail('等待回复仅适用于会话路线');opts.wait=true;}
 if(req.noSignature===true)opts.noSignature=true;
 if(req.mode)opts.mode=req.mode;
 const cdp=opts.route==='desktopcdp'||(opts.route==='auto'&&String(req.to).startsWith('zcode:'));
 if(cdp){opts.cdpPort=port(req.cdpPort,9222);if(req.cdpTargetId)opts.cdpTargetId=String(req.cdpTargetId);}
 return opts;
}
async function handle(req){
 if(req.action.startsWith('fleet.')||req.action.startsWith('ssh.')||req.action.startsWith('remote.'))return require('./fleet-api').handle(req);
 const file=path.join(root(),'desktop-preferences.json');
 switch(req.action){
 case 'preferences.get':return read(file);
 case 'preferences.sessionView':if(!['project','agent'].includes(req.mode))throw fail('会话视图无效');return write(file,{...read(file),sessionView:req.mode});
 case 'preferences.save': {
   const p=req.preferences||{};
   if(!['auto','session','desktopcdp','desktop','relay','mailbox'].includes(p.route||'auto'))throw fail('投递路线无效');
   if(!/^[A-Za-z][A-Za-z0-9_.-]*:\S+$/.test(p.from||'desktop:operator'))throw fail('发送方需要 agent:session 格式');
   if(p.sessionView!==undefined&&!['project','agent'].includes(p.sessionView))throw fail('会话视图无效');
   const value={sessionView:p.sessionView||'project',from:p.from||'desktop:operator',route:p.route||'auto',cdpPort:port(p.cdpPort,9222),timeoutMs:Number(p.timeoutMs||60000),refreshSeconds:Number(p.refreshSeconds||12),url:String(p.url||'http://127.0.0.1:9330'),encryptedToken:String(p.encryptedToken||'')};
   if(value.timeoutMs<1000||value.timeoutMs>300000||!Number.isInteger(value.timeoutMs)||!Number.isInteger(value.refreshSeconds)||value.refreshSeconds<3||value.refreshSeconds>300)throw fail('超时或刷新间隔超出范围');
   return write(file,value);
 }
 case 'token.generate':return {token:crypto.randomBytes(32).toString('hex')};
 case 'message.get': {
   const row=inbox.get(String(req.id));if(!row)throw fail('消息不存在');
   return {id:row.id,to:row.to_addr,from:row.from_addr,text:row.text,status:row.status,route:row.delivery||'auto',detail:row.last_error||''};
 }
 case 'message.retry': {
   const old=inbox.get(String(req.originalId));if(!old)throw fail('原消息不存在');
   const status=old.status==='sent'&&String(old.delivery).startsWith('mailbox')?'stored':old.status;
   if(!['refused','failed','stored','uncertain','pending'].includes(status))throw fail('此状态不能直接重试，请先核实投递结果');
   if(['uncertain','pending'].includes(status)&&req.verified!==true)throw fail('请先核实上次未送达，再勾选确认');
   if(req.id===old.id)throw fail('再次投递必须使用新的消息 ID');
   const result=await sdk.sendRouted(req.to||old.to_addr,req.text==null?old.text:req.text,sendOptions(req));
   return {...result,retryOf:old.id};
 }
 case 'message.remoteStatus': {
   const row=inbox.get(String(req.id));if(!row||!row.to_addr.startsWith('node:'))throw fail('请选择远端消息');
   return sdk.relayStatus(row.id,{url:req.url,token:req.token});
 }
 case 'message.hubRetry':return require(lib+'distributed').request({url:req.url,token:req.token},'POST','/messages/'+encodeURIComponent(req.id)+'/retry',{});
 case 'session.read': {
   const m=/^([^:]+):(.+)$/.exec(String(req.address));if(!m||m[1]==='node')throw fail('请选择本机会话');
   const turns=sdk.readSession(m[2],{agent:m[1],last:Math.min(100,Math.max(1,Number(req.last)||20))});
   return {text:turns.map(t=>'['+t.role+']\n'+String(t.text).slice(0,8000)).join('\n\n')};
 }
 case 'session.new':if(!req.text||!String(req.text).trim())throw fail('请输入首条消息');return {result:await sdk.send('',String(req.text),{fresh:true,cwd:req.cwd||undefined,noWait:true})};
 case 'cdp.target': {
   const match=/^zcode:(\S+)$/.exec(String(req.to));if(!match)throw fail('此检查需要 ZCode 会话地址');
   const session=require(lib+'adapters/zcode').get(match[1]);if(!session)throw fail('目标会话不存在');
   return require(lib+'desktop-delivery').inspectDesktopTarget(session,{cdpPort:port(req.port,9222),cdpTargetId:req.targetId||undefined,timeoutMs:15000});
 }
 case 'cdp.probe':return {page:await require(lib+'desktop-delivery').verifyCdpEndpoint(port(req.port,9222),require(lib+'desktop-delivery').CDP_IDENTITY)};
 case 'diagnostics':return {node:process.version,home:root(),inbox:inbox.DB_PATH(),agents:sdk.agents(),targetsFile:path.join(root(),'desktop-targets.json'),hooksFile:path.join(root(),'hooks.json'),groupsFile:path.join(root(),'groups.json')};
 case 'target.import': {
   const info=fs.statSync(String(req.file));if(!info.isFile()||info.size>8192)throw fail('请选择小于 8KB 的终端描述文件');
   const target=read(String(req.file));require(lib+'delivery').validateTarget(target);if(target.type!=='terminal')throw fail('请选择受控终端描述文件');return {name:path.basename(req.file,'.json'),...target};
 }
 case 'groups.disable': {
   const file=path.join(root(),'groups.json');if(!fs.existsSync(file))return {disabled:true};
   if(!fs.lstatSync(file).isFile())throw fail('分组配置不是普通文件，未修改');
   const backup=file+'.disabled-'+crypto.randomUUID();fs.renameSync(file,backup);return {disabled:true,backup};
 }
 case 'config.get': {
   if(req.kind==='targets')return {rows:Object.entries(read(path.join(root(),'desktop-targets.json'))).map(([name,t])=>({name,type:t.type,value:t.sessionId||t.socket,extra:String(t.cdpPort||''),secret:t.secret||'',targetId:t.cdpTargetId||''}))};
   if(req.kind==='hooks')return {rows:Object.entries(read(path.join(root(),'hooks.json'))).flatMap(([event,cmd])=>(Array.isArray(cmd)?cmd:[cmd]).map(command=>({name:event,value:command})))};
   if(req.kind==='groups'){const r=read(path.join(root(),'groups.json'));return {rows:[...Object.entries(r.groups||{}).map(([name,members])=>({type:'group',name,value:members.join(', ')})),...Object.entries(r.owners||{}).map(([name,value])=>({type:'owner',name,value}))]};}
   throw fail('未知配置分类');
 }
 case 'config.save': {
   if(!Array.isArray(req.rows)||req.rows.length>128)throw fail('配置行数不正确');
   if(req.kind==='hooks'){
     const config={};for(const row of req.rows){if(!require(lib+'hooks').EVENTS.includes(row.name)||typeof row.value!=='string'||!row.value.trim())throw fail('钩子事件或命令无效');(config[row.name]??=[]).push(row.value);}
     return write(path.join(root(),'hooks.json'),config);
   }
   if(req.kind==='groups'){
     const config={...read(path.join(root(),'groups.json')),groups:Object.create(null),owners:Object.create(null)};for(const row of req.rows){if(!row.name||!row.value||!['group','owner'].includes(row.type))throw fail('分组类型、名称或值无效');const table=row.type==='group'?config.groups:config.owners;if(Object.hasOwn(table,row.name))throw fail('分组配置存在重复名称');table[row.name]=row.type==='group'?row.value.split(',').map(v=>v.trim()).filter(Boolean):row.value;}
     return write(path.join(root(),'groups.json'),config);
   }
   if(req.kind==='targets'){
     const config={};for(const row of req.rows){if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(row.name)||Object.hasOwn(config,row.name))throw fail('目标名称无效或重复');
       const t=row.type==='zcode'?{type:'zcode',sessionId:row.value,cdpPort:port(row.extra,9222),...(row.targetId?{cdpTargetId:row.targetId}:{})}:{type:row.type,socket:row.value,secret:row.secret};
       require(lib+'delivery').validateTarget(t);config[row.name]=t;
     }
     return write(path.join(root(),'desktop-targets.json'),config);
   }
   throw fail('未知配置分类');
 }
 default:throw fail('Unsupported desktop action');
 }
}
module.exports={handle,sendOptions,root,port};
