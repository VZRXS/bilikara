// P9: R1 T6/T8 scenarios run against next's production Manage DOM and modules.
// HTTP and native-window boundaries are fixtures; no receiver qualification.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chromium} from 'playwright';

export const read=name=>readFileSync(new URL(`../static/${name}`,import.meta.url),'utf8');
export const dictionary=JSON.parse(read('i18n.json')).languages;
const html=read('index.html');
const settings=html.slice(html.indexOf('<section class="settings-section settings-section-card purek-settings"'),html.indexOf('</section>',html.indexOf('id="purek-settings"'))+10);
const modal=html.slice(html.indexOf('<div class="selection-modal hidden" id="purek-modal"'),html.indexOf('<script src="/part-selector.js"'));
export function appSection(start,end){const app=read('app.js'),a=app.indexOf(start),b=app.indexOf(end,a);assert.ok(a>=0&&b>a,start);return app.slice(a,b);}

export async function openManage(t,{width=700,height=800,language='zh',platform='desktop',selfTest=false,hasTouch=true}={}){
  const browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required']});
  t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width,height},hasTouch});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));t.after(()=>assert.deepEqual(errors,[]));
  await page.setContent(`<html data-host-platform="${platform}"><head><style>${['accent-palette.css','styles.css','request-tabs.css','song-detail.css','ui-surfaces.css','media-output.css','purek-room.css'].map(read).join('\n')}
    body{margin:0;min-width:0;}#settings{padding:14px;max-width:440px;}#settings .purek-settings{display:block;}
    </style></head><body><main id="settings">${settings}</main>${modal}<div id="android-my-scroll"></div></body></html>`);
  await page.evaluate(({dictionary,language,selfTest})=>{
    window.dictionary=dictionary;window.language=language;
    const data={revision:5,state_revision:5,playback_generation:3,current_item:{id:'song'},
      purek:{state_epoch:'fixture',revision:5,connected:false,room_name:null,busy:false},
      ktv_assistance:{host_epoch:'fixture',revision:5,devices:[],session:null},
      cast:{phase:'idle',operation_id:0,connected:false,owns_playback:false,renderers:[{device_key:'one',label:'Living room',preferences_persisted:false},{device_key:'two',label:'Other room',preferences_persisted:true}],devices:{one:{mode:'auto'}},...(selfTest?{self_test:{}}:{})},
      media_output:{target:'local',requested_target:'local',status:'stopped',available:true,authorized:false,can_manage:true,busy:false},player_settings:{key_shift:0}};
    window.state={data,presentationSession:{mode:'singleScreen',phase:'inactive',generation:0},presentationControlBusy:false};
    const calls=[],waiting=[],messages=[];let refreshes=0;
    const sync=()=>{BilikaraPureK.sync(state.data.purek);window.syncOutput();};
    window.t=(key,values={})=>Object.entries(values).reduce((text,[name,value])=>text.replaceAll(`{${name}}`,String(value)),dictionary[window.language][key]||key);
    window.setAppMessage=message=>messages.push(message);
    window.render=sync;window.closeCacheAdvancedInfo=()=>{};window.syncPresentationPanelVisibility=()=>{};
    window.setRemoteQrPinned=()=>{};window.bindHostContextualInfo=()=>{};window.renderPresentationHostSurface=()=>{};
    window.BilikaraKtvScanner={surface:({onDecode})=>(window.fixtureDecode=onDecode,{gallery:document.createElement('button'),stop(){},setDisabled(){},open:async()=>{},waitingForAndroidPermission:()=>false}),validOfficial:url=>/^https?:\/\/wx\.chunk\.cn(?::\d+)?\//i.test(url)};
    window.apiPost=(path,payload)=>{calls.push({path,payload});return new Promise((resolve,reject)=>waiting.push({path,resolve,reject}));};
    window.acceptHostStateSnapshot=value=>{if(value.state_revision<state.data.state_revision)return false;state.data=value;return true;};
    window.fetch=async path=>{
      if(path==='/api/state'){
        refreshes++;state.data.revision++;state.data.state_revision++;state.data.purek.revision=state.data.state_revision;
        state.data.ktv_assistance.revision=state.data.state_revision;
      }
      return {ok:true,json:async()=>({ok:true,data:path==='/api/ktv/host'?state.data.ktv_assistance:path.endsWith('/report')?{text:'Safe diagnostic summary',diagnostics:{cast_self_test:{schema_version:1,conclusion:{decision_row:2},cells:[]}}}:structuredClone(state.data)})};
    };
    window.tauriInvoke=()=>null;
    window.handlePresentationSession=async value=>{state.presentationSession=value;BilikaraPureK.syncPresentation();};
    window.deactivateLocalPresentation=async()=>{calls.push({native:'closePhysical'});state.presentationSession.phase='recovering';};
    window.saveTauriBackendDownload=()=>apiPost('/fixture/save',{});
    window.BilikaraDiagnosticsCopy={copyText:value=>apiPost('/fixture/copy',{text:value})};
    window.fixture={state,calls,messages,refreshes:()=>refreshes,
      update(patch){for(const key of ['cast','purek','media_output'])if(patch[key])patch[key]={...state.data[key],...patch[key]};Object.assign(state.data,patch);sync();},
      resolve(value,path){const at=path?waiting.findIndex(p=>p.path===path):0;if(at<0||!waiting.length)throw Error('No pending request '+path);waiting.splice(at,1)[0].resolve(value);},
      reject(code,path){const at=path?waiting.findIndex(p=>p.path===path):0;waiting.splice(at,1)[0].reject({code});},
      language(value){window.language=value;document.querySelectorAll('[data-i18n]').forEach(n=>n.textContent=t(n.dataset.i18n));document.dispatchEvent(new Event('bilikara:i18n'));},
      finishPhysical(){state.presentationSession={mode:'singleScreen',phase:'inactive',generation:2};BilikaraPureK.syncPresentation();},
      native(){window.tauriInvoke=()=>async(command,args)=>{calls.push({native:command,args});return {mode:args.active?'networkRenderer':'singleScreen',phase:args.active?'active':'inactive',generation:args.generation+1};};},
    };
  },{dictionary,language,selfTest});
  await page.addScriptTag({content:read('media-output.js')});
  await page.addScriptTag({content:read('cast-self-test.js')});
  await page.addScriptTag({content:appSection('function syncMediaOutputComponents()', 'function holdLocalPlaybackForNetworkOutput()')+'\nwindow.syncOutput=syncMediaOutputComponents;'});
  const scanner=read('ktv-scanner.js');
  await page.addScriptTag({content:scanner.replace('window.BilikaraKtvScanner=Object.freeze({create,surface,decode,validOfficial,coverRegion,classify});','window.BilikaraKtvScanner.classify=classify;')});
  await page.addScriptTag({content:read('purek-room.js')});
  await page.evaluate(language=>{fixture.language(language);render();},language);
  await page.locator('#purek-open').click();
  await page.waitForFunction(()=>!document.getElementById('purek-open').hasAttribute('aria-busy'));
  await page.locator('#purek-modal').evaluate(async modal=>{
    await Promise.all(modal.getAnimations({subtree:true}).map(animation=>animation.finished.catch(()=>{})));
  });
  return page;
}

export async function idle(page,selector){await page.waitForFunction(selector=>!document.querySelector(selector).hasAttribute('aria-busy'),selector);}
