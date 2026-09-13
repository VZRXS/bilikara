const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('static/remote.js', 'utf8');
const fn = source.slice(source.indexOf('function submitSongRating('), source.indexOf('function ratingItemUrl('));
(async () => {
  let resolve, calls = 0, errors = 0;
  const state = {ratingSubmittedKeys:new Set(), pendingAutoRatings:new Map(),autoRatingFlushQueue:[],data:{}};
  const button = {disabled:false, attrs:{},setAttribute(k,v){this.attrs[k]=v;},removeAttribute(k){delete this.attrs[k];}};
  const context = {state, console:{warn(){}}, ratingLog(){}, ratingSubmissionUserName:()=>'Alice',
    ratingSubmissionPlayId:()=> 'played', ratingSubmissionKey:()=> 'alice::played',
    clientHeaders:h=>h, t:k=>k, setAppMessage:()=>errors++,renderCurrentRatingButton(){},
    fetch:()=>{calls++; return new Promise(r=>{resolve=r;});}};
  vm.createContext(context); vm.runInContext(fn,context);
  const tick = () => new Promise(r=>setImmediate(r));
  const item = {id:'played',bvid:'BV1z84y1p7oS'};
  for(const response of [
    {ok:false,json:async()=>({ok:false,error:'offline'})},
    {ok:true,json:async()=>({data:{success:false}})},
    {ok:true,json:async()=>{throw Error('bad JSON');}}
  ]) {
    assert.equal(context.submitSongRating(item,4,button),true);
    assert.equal(button.disabled,true); assert.equal(button.attrs['aria-busy'],'true');
    const before = calls;
    assert.equal(context.submitSongRating(item,4,button),false); assert.equal(calls,before);
    resolve(response); await tick();
    assert.equal(state.ratingSubmittedKeys.size,0);
    assert.equal(button.disabled,false); assert.equal(button.attrs['aria-busy'],undefined);
  }
  assert.equal(errors,3);
  context.submitSongRating(item,4,button);
  resolve({ok:true,json:async()=>({ok:true,data:{success:true}})}); await tick();
  assert.equal(state.ratingSubmittedKeys.size,1);
  assert.equal(context.submitSongRating(item,5,button),false);
  assert.equal(button.disabled,false);
  console.log('Remote rating retries and busy/dedup guards: PASS');
})().catch(e=>{console.error(e);process.exitCode=1;});
