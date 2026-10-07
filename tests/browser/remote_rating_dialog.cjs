'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');

// The entry is navigation; only the dialog's submission controls reflect
// eligibility. Requests stay local to this fixture and never reach the cloud.
module.exports = async function checkRatingDialog(page, item, notes, { role = 'remote' } = {}) {
 const requests=[];
 let release=null,hold=false,fail=false;
 await page.route('**/api/rating/submit',async route=>{
  requests.push(route.request().postDataJSON());
  if(hold)await new Promise(resolve=>{release=resolve;});
  await route.fulfill({status:fail?503:200,contentType:'application/json',body:JSON.stringify(
   fail?{ok:false,error:'Fixture rating failed'}:{ok:true,data:{success:true,queued:true}}
  )});
 });
 const button=page.locator('#open-rating-button');
 const modal=page.locator('.rating-modal:not(.closing)');
 const submit=modal.locator('[data-rating-submit]');
 const close=()=>modal.locator('.rating-close').click();
 const entryReady=async()=>{
  assert.equal(await button.innerText(),await page.evaluate(()=>t('rating.rate')));
  assert.equal(await button.isDisabled(),false);
  assert.equal(await button.getAttribute('aria-busy'),null);
 };
 const status=async(value,score=3)=>page.evaluate(({value,score})=>{
  state.data.song_ratings=value?[{play_id:'rating-current',session_user_name:selectedRequesterName(),status:value,score}]:[];
  renderCurrentRatingButton(state.data.current_item);
 },{value,score});
 try {
  if (role === 'remote') await page.waitForFunction(()=>!remoteIdentityModalIsOpen());
  await page.setViewportSize(role === 'remote' ? {width:440,height:956} : {width:1920,height:1080});
  await page.evaluate(({item,role})=>{
   fetchState=async()=>{};state.eventSource?.close();state.ratingOptOut=true;
   state.ratingSubmittedKeys.clear();state.ratingPendingKeys.clear();state.ratingQueuedKeys.clear();state.ratingSavedScores.clear();
   const current={...item,id:'rating-current',display_title:'Current song',requester_name:selectedRequesterName(),cache_status:'pending'};
   const previous={...item,id:'rating-previous',item_id:'rating-previous',bvid:'BV0000000001',threshold_reached:false};
   state.data={...state.data,song_ratings:[],current_item:current,session_played:[previous]};
   if (role === 'remote') {
    renderCurrentItem(current);
    if(!openPlaybackSheet())throw Error('Fixture playback sheet did not open');
   } else {
    activateHostWorkspace('queue', {inputOrigin:'programmatic'});
    renderQueueCurrent(current);
   }
   renderCurrentRatingButton(current);
  },{item,role});
  // Every backend status opens, including a song that can only be viewed.
  for(const [value,disabled] of [['',false],['waiting',false],['sending',true],['accepted',true],['failed',false]]) {
   await status(value);await entryReady();await button.click();await modal.waitFor();
   assert.equal(await submit.isDisabled(),disabled,value);
   if(value)assert.equal(await modal.locator('[data-rating-score="3"]').getAttribute('aria-pressed'),'true');
   if(['waiting','accepted'].includes(value)) {
    await page.evaluate(()=>Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))));
    await modal.screenshot({path:path.join(notes,`${role}-rating-${value}-dialog.png`)});
   }
   await close();assert.equal(requests.length,0,'Opening and closing never submits');
  }
  await page.screenshot({path:path.join(notes,`${role}-rating-entry.png`)});
  // Waiting scores reopen with their confirmed value and can be overwritten.
  await status('waiting');await button.click();
  await modal.locator('[data-rating-score="2"]').click();await submit.click();
  await page.waitForFunction(()=>state.ratingPendingKeys.size===0&&state.ratingSavedScores.size===1);
  assert.deepEqual(requests.map(r=>r.score),[2]);
  await entryReady();await button.click();
  assert.equal(await modal.locator('[data-rating-score="2"]').getAttribute('aria-pressed'),'true');
  await modal.locator('[data-rating-score="4"]').click();
  await status('waiting',2);
  assert.equal(await modal.locator('[data-rating-score="4"]').getAttribute('aria-pressed'),'true','SSE preserves an editable draft');
  if (role === 'host') {
   const original=await page.evaluate(()=>({users:state.data.session_users,entries:state.data.session_user_entries,
    ratings:state.data.song_ratings,requester:selectedRequesterName()}));
   await page.evaluate(()=>{
    const selected=state.data.session_user_entries.find(user=>user.name===selectedRequesterName());
    if(!selected?.id)throw Error('Fixture requester lacks a stable user ID');
    state.data.session_user_entries=[{...selected,name:'Alice renamed'}];
    state.data.session_users=['Alice renamed'];
    renderRequesterSelect(state.data.session_users);renderCurrentRatingButton(state.data.current_item);
   });
   assert.equal(await modal.locator('[data-rating-score="4"]').getAttribute('aria-pressed'),'true','A stable user rename preserves their draft');
   await page.evaluate(()=>{
    state.data.session_user_entries=[{id:'rating-fixture-bob',name:'Bob'}];state.data.session_users=['Bob'];
    state.data.song_ratings=[{play_id:'rating-current',session_user_id:'rating-fixture-bob',session_user_name:'Bob',status:'waiting',score:1}];
    renderRequesterSelect(state.data.session_users);renderCurrentRatingButton(state.data.current_item);
   });
   assert.equal(await modal.locator('[data-rating-score="1"]').getAttribute('aria-pressed'),'true','Removing the selected user loads the replacement user’s own saved score');
   await page.evaluate(original=>{
    state.data.session_users=original.users;state.data.session_user_entries=original.entries;state.data.song_ratings=original.ratings;
    renderRequesterSelect(original.users);elements.requesterSelect.value=original.requester;renderCurrentRatingButton(state.data.current_item);
   },original);
   await modal.locator('[data-rating-score="4"]').click();
  }
  await status('sending',2);
  assert.equal(await modal.isVisible(),true,'A status update must not dismiss the dialog');
  assert.equal(await submit.isDisabled(),true);
  assert.equal(await modal.locator('[data-rating-score="2"]').getAttribute('aria-pressed'),'true','Read-only state shows the actual sent score');
  await status('accepted',2);assert.equal(await submit.isDisabled(),true);
  await status('failed',2);assert.equal(await submit.isDisabled(),false);
  // An ineligible previous song remains viewable; submission is disabled.
  await modal.locator('[data-rating-tab="previous"]').click();assert.equal(await submit.isDisabled(),true);
  await modal.locator('[data-rating-tab="current"]').click();assert.equal(await submit.isDisabled(),false);
  await modal.locator('[data-rating-score="4"]').click();await page.keyboard.press('Escape');
  await modal.waitFor({state:'hidden'});assert.equal(requests.length,1);
  // Keep the entry openable during a request, but prevent another submission.
  hold=true;fail=true;await button.click();await submit.click();
  await page.waitForFunction(()=>state.ratingPendingKeys.size===1);await entryReady();await button.click();
  assert.equal(await submit.isDisabled(),true);assert.equal(await submit.getAttribute('aria-busy'),'true');
  assert.equal(requests.length,2);
  while(!release)await new Promise(r=>setTimeout(r,10));
  hold=false;release();release=null;
  await page.waitForFunction(()=>state.ratingPendingKeys.size===0);
  assert.equal(await modal.isVisible(),true);assert.equal(await submit.isDisabled(),false);
  assert.equal(await submit.getAttribute('aria-busy'),null);await close();fail=false;
  // No current song, no eligible previous song, and no rating capability
  // affect submission, not the navigation control.
  await page.evaluate(()=>{state.data.current_item=null;renderCurrentRatingButton(null);});
  await entryReady();await button.click();assert.equal(await submit.isDisabled(),true);await close();
  await page.evaluate(()=>{state.data.session_played[0].threshold_reached=true;renderCurrentRatingButton(null);});
  await button.click();assert.equal(await submit.isDisabled(),false);await close();
  await page.evaluate(()=>{state.data.capabilities.song_rating=false;renderCurrentRatingButton(null);});
  await button.click();assert.equal(await submit.isDisabled(),true);await close();
  await page.evaluate(()=>{state.data.session_played=[];renderCurrentRatingButton(null);});
  await button.click();assert.equal(await submit.isDisabled(),true);await close();
  assert.equal(requests.length,2,'View-only states never submit');
 } catch(error) {
  await page.screenshot({path:path.join(notes,`${role}-rating-failure.png`)});
  throw error;
 } finally {
  release?.();await page.evaluate(()=>closeRatingPrompt({submit:false}));
  await page.unroute('**/api/rating/submit');await page.reload();await page.waitForFunction(()=>state.data?.capabilities);
 }
};
