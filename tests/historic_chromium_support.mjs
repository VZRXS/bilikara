import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
export async function historicChromium(t, executable) {
  const profile = mkdtempSync(path.join(tmpdir(), 'bilikara-engine-'));
  const child = spawn(executable, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking',
    '--proxy-server=http://127.0.0.1:1', '--proxy-bypass-list=127.0.0.1;localhost', '--remote-debugging-port=0', '--user-data-dir='+profile, 'about:blank'], {stdio:['ignore','ignore','pipe']});
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  t.after(async () => {child.kill('SIGKILL'); await exited; rmSync(profile, {recursive:true,force:true});});
  let timer;
  const endpoint = await new Promise((resolve,reject) => {
    let output=''; child.on('error',reject); child.stderr.on('data', data => {
      output=(output+data).slice(-8192); const match=/DevTools listening on (ws:\/\/[^\s]+)/.exec(output);
      if(match) {clearTimeout(timer);resolve(match[1]);}
    }); timer=setTimeout(()=>reject(new Error('Historic engine startup deadline')),15000);
  }).finally(()=>clearTimeout(timer));
  let target;
  for(let i=0;i<100&&!target;i++) {
    target=(await(await fetch('http://127.0.0.1:'+new URL(endpoint).port+'/json/list')).json()).find(t=>t.type==='page');
    if(!target) await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.ok(target);
  const socket=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  t.after(()=>socket.close());
  let sequence=0; const pending=new Map(), exceptions=[];
  socket.addEventListener('message', event=>{
    const m=JSON.parse(event.data);
    if(m.method==='Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails);
    if(m.id) {const p=pending.get(m.id);pending.delete(m.id);if(p)m.error?p.reject(m.error):p.resolve(m.result);}
  });
  const send=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++sequence, timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+' deadline'));},15000);
    pending.set(id,{resolve:r=>{clearTimeout(timer);resolve(r);},reject:e=>{clearTimeout(timer);reject(e);}});
    socket.send(JSON.stringify({id,method,params}));
  });
  const evaluate=async expression=>{
    const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    assert.ok(!r.exceptionDetails,JSON.stringify(r.exceptionDetails));return r.result.value;
  };
  const wait=async expression=>{
    for(let i=0;i<100;i++){if(await evaluate(expression))return;await new Promise(resolve=>setTimeout(resolve,100));}
    assert.fail('Historic engine condition deadline: '+expression);
  };
  await send('Runtime.enable'); await send('Page.enable');
  return {send,evaluate,wait,exceptions};
}
