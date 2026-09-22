const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
(async () => {
 for (const file of ['static/app.js', 'static/remote.js']) {
  const source = fs.readFileSync(file, 'utf8');
  const fn = source.slice(source.indexOf('function submitSongRating('), source.indexOf('function ratingItemUrl('));
  let resolve, calls = 0, errors = 0, payload;
  const state = {ratingSubmittedKeys:new Set(),ratingPendingKeys:new Set(),ratingPromptSeenPlayIds:new Set(), pendingAutoRatings:new Map(),autoRatingFlushQueue:[],data:{}};
  const button = {disabled:false, attrs:{},setAttribute(k,v){this.attrs[k]=v;},removeAttribute(k){delete this.attrs[k];}};
  const context = {state, console:{warn(){}}, ratingLog(){}, ratingSubmissionUserName:()=>'Alice',
    ratingSubmissionPlayId:()=> 'played', ratingSubmissionKey:()=> 'alice::played',
    clientHeaders:h=>h, t:k=>k, setAppMessage:()=>errors++,renderCurrentRatingButton(){},
    fetch:(_url,options)=>{payload=JSON.parse(options.body);calls++; return new Promise(r=>{resolve=r;});}};
  vm.createContext(context); vm.runInContext(fn,context);
  const tick = () => new Promise(r=>setImmediate(r));
  const item = {id:'played',bvid:'BV1z84y1p7oS'};
  for(const response of [
    {ok:false,json:async()=>({ok:false,error:'offline'})},
    {ok:true,json:async()=>({ok:true,data:{success:false}})},
    {ok:true,json:async()=>{throw Error('bad JSON');}},
    {ok:true,json:async()=>({})}
  ]) {
    assert.equal(context.submitSongRating(item,4,button),true);
    assert.equal(button.disabled,true); assert.equal(button.attrs['aria-busy'],'true');
    assert.equal(state.ratingSubmittedKeys.size,0, 'pending is not confirmed');
    const before = calls;
    assert.equal(context.submitSongRating(item,4,button),false); assert.equal(calls,before);
    resolve(response); await tick();
    assert.equal(state.ratingSubmittedKeys.size,0);
    assert.equal(button.disabled,false); assert.equal(button.attrs['aria-busy'],undefined);
  }
  assert.equal(errors,4);
  state.pendingAutoRatings.set('played',{item});
  state.autoRatingFlushQueue.push({playId:'played',item});
  context.submitSongRating(item,4,button);
  if(file.endsWith('remote.js')) {
    assert.equal(state.pendingAutoRatings.size,0);
    assert.equal(state.autoRatingFlushQueue.length,0);
  }
  resolve({ok:true,json:async()=>({ok:true,data:{success:true}})}); await tick();
  assert.equal(state.ratingSubmittedKeys.size,1);
  assert.equal(context.submitSongRating(item,5,button),false);
  assert.equal(button.disabled,false);
  if(file.endsWith('remote.js')) {
    vm.runInContext(source.slice(source.indexOf('function flushPendingAutoRating('),source.indexOf('function flushAllPendingAutoRatings(')), context);
    const before=calls;
    context.flushPendingAutoRating('played',{item});assert.equal(calls,before);
    state.ratingSubmittedKeys.clear();
    context.flushPendingAutoRating('played',{item});assert.equal(calls,before+1);assert.equal(payload.score,5);
    context.flushPendingAutoRating('played',{item});assert.equal(calls,before+1);
    resolve({ok:true,json:async()=>({ok:true,data:{success:true}})});await tick();
    assert.equal(state.ratingSubmittedKeys.size,1);
  }
  console.log(file + ' rating retries and busy/dedup guards: PASS');
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
