'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const [slot,nodeId,url]=process.argv.slice(2);let text='',stopping=false,job,server,runtime,exitCode=0;
const file=path.join(slot,'runtime.json');
async function cleanup(){try{const saved=JSON.parse(fs.readFileSync(file,'utf8'));if(saved.nonce===runtime.nonce)fs.unlinkSync(file);}catch{}if(server)server.close();process.exit(exitCode);}
process.stdin.setEncoding('utf8');process.stdin.on('data',data=>{text+=data;if(text.length>10000)process.exit(2);});
process.stdin.on('end',async()=>{
 const config=JSON.parse(text);text='';
 const write=process.stderr.write.bind(process.stderr);process.stderr.write=(chunk,...args)=>write(String(chunk).split(config.token).join('[redacted]'),...args);
 server=http.createServer((req,res)=>{
   const given=req.headers.authorization||'',expected='Bearer '+runtime.nonce;
   if(given.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(given),Buffer.from(expected))){res.writeHead(403).end();return;}
   if(req.url==='/stop'&&req.method==='POST'){stopping=true;process.emit('SIGTERM');}
   else if(req.url!=='/status'||req.method!=='GET'){res.writeHead(404).end();return;}
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify({pid:process.pid,nodeId,version:require('./package.json').version,state:stopping?'stopping':'running'}));
 });
 server.on('error',e=>{console.error(e.message);process.exit(1);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 runtime={pid:process.pid,nodeId,port:server.address().port,nonce:crypto.randomBytes(32).toString('hex')};
 job=require('./lib/distributed').runNode({url,token:config.token,nodeId,dataDir:path.join(slot,'state'),targetsFile:path.join(slot,'targets.json'),onStarted:()=>{fs.writeFileSync(file,JSON.stringify(runtime),{mode:0o600});require('./lib/secure-fs').protectPath(file);}});
 job.then(cleanup).catch(e=>{console.error(e.message);exitCode=1;cleanup();});
 const stopTimer=setInterval(()=>{if(stopping)process.emit('SIGTERM');},1000);stopTimer.unref();
});
