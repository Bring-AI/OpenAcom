'use strict';
// One bounded JSON request on stdin. No HTTP listener; no credentials in argv.
const path = require('node:path');
const fs = require('node:fs');
const lib = fs.existsSync(path.join(__dirname,'lib/sdk.js')) ? './lib/' : '../lib/';
const sdk = require(lib + 'sdk');
const inbox = require(lib + 'inbox');
const clamp = (s, n = 2000) => Buffer.from(String(s ?? '').slice(0,n),'utf16le').toString('utf16le');
// Display metadata never changes the address used for reading or delivery.
function sessionProject(workspace, scope='local') {
  if(typeof workspace!=='string'||!workspace.trim())return {workspace:'',projectKey:JSON.stringify([scope,'unassigned']),projectLabel:scope==='local'?'未标注项目':'未标注项目 · '+scope.slice(5),projectDescription:scope==='local'?'会话没有提供工作目录':scope.slice(5)};
  const raw=workspace.trim();const windows=/^[A-Za-z]:[\\/]|^\\\\|^\/\//.test(raw);
  const normalized=(windows?path.win32.normalize(raw):path.posix.normalize(raw)).replace(/\\/g,'/');
  const root=(windows?path.win32.parse(raw).root:path.posix.parse(raw).root).replace(/\\/g,'/');
  const directory=normalized.length>root.length?normalized.replace(/\/+$/,''):normalized;
  return {workspace:directory,projectKey:JSON.stringify([scope,windows?directory.toLowerCase():directory]),projectLabel:path.posix.basename(directory)||directory,projectDescription:scope==='local'?directory:scope.slice(5)+' · '+directory};
}
function agentType(value){return typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value)?value.toLowerCase():'unknown';}
async function execute(req) {
  if (req.action === 'health') return {runtime:process.version,protocol:1};
  if (req.action === 'snapshot') {
    const messages = inbox.list({limit:200}).map(row=>({
      id:row.id, from:row.from_addr, to:row.to_addr, text:clamp(row.text), status:row.status === 'sent' && String(row.delivery).startsWith('mailbox') ? 'stored' : row.status,
      route:row.delivery || 'session', time:row.updated_at, detail:clamp(row.last_error,500),
    }));
    if (req.remote) {
      const result = await sdk.relayNodes({url:req.url,token:req.token});
      const sessions = (result.nodes || []).flatMap(node=>(node.targets || []).map(target=>({
        id:`node:${node.id}/${typeof target === 'string' ? target : target.name}`,
        title:typeof target === 'string' ? target : target.name,
        agent:typeof target==='string'?'unknown':agentType(target.agent||target.agentType),nodeId:node.id,status:node.online ? '在线' : '离线',
        ...sessionProject(typeof target==='string'?undefined:target.workspace,'node:'+node.id),
      })));
      return {messages,sessions};
    }
    let sessions = [], warning;
    try {sessions=sdk.listSessions({limit:Math.min(200,Math.max(1,Number(req.limit)||60)),query:req.query||undefined}).map(row=>({id:`${row.agent}:${row.id}`,title:clamp(row.title,120),agent:agentType(row.agent),status:'本机',...sessionProject(row.workspace)}));}
    catch(error){warning=clamp(error.message,300);}
    return {messages,sessions,warning};
  }
  if(req.action === 'send') {
    const opts = require('./control-api').sendOptions(req);
    return sdk.sendRouted(req.to,req.text,opts);
  }
  if(req.action === 'ack') return sdk.ackMessage(req.id,{via:'desktop'});
  return require('./control-api').handle(req);
}
if(require.main === module) {
  let chunks=[],size=0;
  process.stdin.on('data', chunk=>{size+=chunk.length;if(size>100000){process.stderr.write('Request too large');process.exit(2);}chunks.push(chunk);});
  process.stdin.on('end',async()=>{
    try {const result=await execute(JSON.parse(Buffer.concat(chunks).toString('utf8')));process.stdout.write(JSON.stringify({ok:true,result}));}
    catch(error){process.stdout.write(JSON.stringify({ok:false,error:clamp(error.message,500),code:error.code || 'DESKTOP_ERROR',uncertain:error.uncertain !== false}));process.exitCode=1;}
    finally{inbox.close();}
  });
}
module.exports={execute};




