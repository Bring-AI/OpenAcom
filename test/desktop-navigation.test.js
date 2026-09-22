'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {selectDesktopSession}=require('../lib/desktop-navigation');
function fixture({active=false,draft=false,exact=true,duplicateTitle=false,remote=false,navigatorCount=1,workspace='F:\\Project',requested='F:/Project'}={}){
 const id='sess-target',title='Same title';let clicked=0,navigated=[];
 const input={textContent:draft?'unsent local text':'',getClientRects:()=>[{}],querySelector:()=>null};
 const label={textContent:title};
 const row={getClientRects:()=>[{}],getAttribute:k=>k==='data-testid'?'task-item-'+id:null,querySelector:()=>label,click:()=>clicked++};
 const other={...row,getAttribute:k=>k==='data-testid'?'task-item-other':null};
 const callbacks=Array.from({length:navigatorCount},()=>function(target){navigated.push(target);});
 const nativeRows=callbacks.map(callback=>({'__reactFiber$test':{memoizedProps:{workspacePath:workspace,workspaceIdentity:remote?'ssh:host':undefined,tasks:[],hasMore:true,onSelectTask:callback}}}));
 const container={querySelectorAll:()=>nativeRows};
 const workspaceRow={getAttribute:k=>k==='data-testid'?'workspace-item-'+workspace:k==='aria-expanded'?'true':'workspace-content',click:()=>{throw Error('should not toggle open workspace')}};
 const sidebar={querySelectorAll:selector=>selector.includes('workspace-item')?[workspaceRow]:exact?[row,...duplicateTitle?[other]:[]]:[]};
 const pane={getClientRects:()=>[{}],getAttribute:()=>id};
 const document={querySelector:()=>sidebar,getElementById:()=>container,querySelectorAll:selector=>selector.includes('composer-input')?[input]:selector.includes('session-pane')&&active?[pane]:[]};
 return {id,title,document,requested,window:{},getComputedStyle:()=>({visibility:'visible',opacity:'1'}),counts:()=>({clicked,navigated})};
}
function run(f){const previous={document:global.document,window:global.window,getComputedStyle:global.getComputedStyle};Object.assign(global,{document:f.document,window:f.window,getComputedStyle:f.getComputedStyle});try{return selectDesktopSession(f.id,f.title,f.requested,'lease',Date.now()+10000);}finally{for(const [k,v]of Object.entries(previous)){if(v===undefined)delete global[k];else global[k]=v;}}}
test('duplicate human titles do not defeat a unique exact session ID',()=>{const f=fixture({duplicateTitle:true});assert.equal(run(f),'selected');assert.equal(f.counts().clicked,1);});
test('an already active exact pane does not require a sidebar row',()=>{const f=fixture({active:true,exact:false});assert.equal(run(f),'active');assert.deepEqual(f.counts(),{clicked:0,navigated:[]});});
test('a not-listed session uses the one native local-workspace navigation callback',()=>{const f=fixture({exact:false});assert.equal(run(f),'navigated');assert.deepEqual(f.counts().navigated,['sess-target']);});
test('remote workspace contexts and ambiguous native navigators are refused',()=>{assert.equal(run(fixture({exact:false,remote:true})),'not-listed');assert.equal(run(fixture({exact:false,navigatorCount:2})),'ambiguous-navigator');});
test('drafts and another sender lease prevent navigation',()=>{const f=fixture({exact:false,draft:true});assert.equal(run(f),'draft');assert.equal(f.counts().navigated.length,0);const busy=fixture();busy.window.__openacomDesktopLease={id:'other',expiry:Date.now()+10000};assert.equal(run(busy),'busy');assert.equal(busy.counts().clicked,0);});

test('case-sensitive workspace paths never route to a different local project',()=>{const f=fixture({exact:false,workspace:'/work/Project',requested:'/work/project'});assert.equal(run(f),'workspace-unavailable');assert.deepEqual(f.counts().navigated,[]);});
