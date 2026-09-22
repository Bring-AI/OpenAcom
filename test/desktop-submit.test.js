'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const driver=require('../lib/desktop-delivery');
async function withRenderer(run,{accept=true,busy=false,noControls=false}={}){
 const before={fetch:global.fetch,WebSocket:global.WebSocket};
 const state={text:'',disabled:true,inputs:0,enters:0,methods:[]};let context;
 const visible=()=>[{}];
 const input={get textContent(){return state.text;},get innerText(){return state.text;},isContentEditable:true,getClientRects:visible,querySelector:()=>null,focus:()=>document.activeElement=input};
 const title={textContent:'Target',getAttribute:()=> 'Target'};
 const button={get disabled(){return state.disabled;}};
 const stop={tagName:'BUTTON'};
 const pane={getClientRects:visible,getAttribute:()=> 'sess-target',querySelector:s=>{
  if(s.includes('composer-input'))return input;
  if(s.includes('session-title'))return title;
  // A running pane swaps the send control for a stop control; noControls models
  // a composer whose controls are entirely absent, which must stay refused.
  if(busy)return noControls?null:(s.includes('v4-stop')?stop:null);
  return s.includes('composer-send')?button:null;
 },querySelectorAll:s=>s.includes('composer-input')?[input]:s.includes('session-title')?[title]:[]};
 const row={getClientRects:visible,getAttribute:()=> 'task-item-sess-target',querySelector:()=>title,click:()=>{}};
 const document={activeElement:null,querySelector:()=>({querySelectorAll:()=>[row]}),querySelectorAll:s=>s.includes('session-pane')?[pane]:s.includes('composer-input')?[input]:[]};
 context=vm.createContext({document,window:{},navigator:{userAgent:'ZCode Electron/41.0'},getComputedStyle:()=>({visibility:'visible',opacity:'1'}),Date,Set});
 class Socket {
  static OPEN=1;readyState=0;listeners={};
  constructor(){queueMicrotask(()=>{this.readyState=1;this.emit('open',{});});}
  addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);}
  emit(name,event){for(const fn of this.listeners[name]||[])fn(event);}
  send(raw){const {id,method,params}=JSON.parse(raw);state.methods.push(method);let result={};
   if(method==='Runtime.evaluate')result={result:{value:vm.runInContext(params.expression,context)}};
   if(method==='Input.insertText'){state.inputs++;state.text=params.text;setTimeout(()=>state.disabled=false,80);}
   if(method==='Input.dispatchKeyEvent'&&params.type==='keyDown'){state.enters++;if(accept)setTimeout(()=>{state.text='';state.disabled=true;},80);}
   queueMicrotask(()=>this.emit('message',{data:JSON.stringify({id,result})}));
  }
  close(){this.readyState=3;this.emit('close',{});}
 }
 global.WebSocket=Socket;
 global.fetch=async url=>({ok:true,text:async()=>JSON.stringify(url.endsWith('/json/version')?{Browser:'Chrome/146', 'User-Agent':'ZCode Electron/41.0'}:[{id:'fixture',type:'page',url:'file:///zcode/index.html'}])});
 try{await run(state);}finally{global.fetch=before.fetch;global.WebSocket=before.WebSocket;}
}
test('target inspection traverses readiness but never inserts text or presses Enter',async()=>withRenderer(async state=>{
 const result=await driver.inspectDesktopTarget({id:'sess-target',title:'Target',directory:'C:/project'});
 assert.equal(result.status,'ready');assert.equal(result.sessionId,'sess-target');
 assert.equal(state.inputs,0);assert.equal(state.enters,0);assert.ok(!state.methods.some(m=>m.startsWith('Input.')));
}));
test('submission waits for the renderer to update and confirms acceptance without duplicate input',async()=>withRenderer(async state=>{
 const result=await driver.sendDesktopStrict({id:'sess-target',title:'Target'},'hello',{mode:'submit',consent:true});
 assert.equal(result.status,'submitted');assert.equal(state.inputs,1);assert.equal(state.enters,1);assert.equal(state.text,'');
}));
test('Enter without observed acceptance is uncertain and is never automatically submitted again',async()=>withRenderer(async state=>{
 await assert.rejects(driver.sendDesktopStrict({id:'sess-target',title:'Target'},'hello',{mode:'submit',consent:true,timeoutMs:1500}),e=>e.code==='INPUT_UNCERTAIN'&&e.uncertain===true);
 assert.equal(state.inputs,1);assert.equal(state.enters,1);assert.equal(state.text,'hello');
},{accept:false}))
test('a running pane swaps the send control for a stop control and still submits',async()=>withRenderer(async state=>{
 const result=await driver.sendDesktopStrict({id:'sess-target',title:'Target'},'hello',{mode:'submit',consent:true});
 assert.equal(result.status,'submitted');assert.equal(state.inputs,1);assert.equal(state.enters,1);assert.equal(state.text,'');
},{busy:true}))
test('inspection accepts a running pane without typing',async()=>withRenderer(async state=>{
 const result=await driver.inspectDesktopTarget({id:'sess-target',title:'Target',directory:'C:/project'});
 assert.equal(result.status,'ready');assert.equal(state.inputs,0);assert.equal(state.enters,0);
},{busy:true}))
test('a pane with neither an idle send nor a running stop control is refused before typing',async()=>withRenderer(async state=>{
 await assert.rejects(driver.sendDesktopStrict({id:'sess-target',title:'Target'},'hello',{mode:'submit',consent:true,timeoutMs:1500}),e=>e.code==='INPUT_LOCKED'&&e.uncertain===false);
 assert.equal(state.inputs,0);assert.equal(state.enters,0);
},{busy:true,noControls:true}));
