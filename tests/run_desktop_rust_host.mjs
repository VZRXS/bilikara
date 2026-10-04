// Real current Host/browser/media orchestration; no external forwarding.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { root, runNative } from './desktop_construction_support.mjs';
import { buildNativeAlpha, buildNativeHost } from './native_runtime_artifacts.mjs';
import { isolatedEnvironment } from './native_host_support.mjs';
import { localCertificate } from './local_tls_certificate.mjs';
import { videoFixture } from './video_service_fixture.mjs';
import { zipEntries } from './native_export_support.mjs';
import { nativeTarget } from './desktop_construction_expectations.mjs';

export async function runDesktopBrowser(evidence, options = [], environment = process.env) {
  assert.equal(process.platform, 'linux', 'actual local TLS/browser test requires Linux native trust');
  for (const flag of options) assert.ok(['--shared-ui', '--cache-policy', '--bbdown', '--bbdown-real'].includes(flag), `unsupported desktop test option ${flag}`);
  const shared = options.includes('--shared-ui'), policy = options.includes('--cache-policy'), real = options.includes('--bbdown-real'), bbdown = real || options.includes('--bbdown');
  assert.ok(environment.BILIKARA_TEST_LIBAV_COMPANION && existsSync(environment.BILIKARA_TEST_LIBAV_COMPANION), 'real prepared BILIKARA_TEST_LIBAV_COMPANION required; no fabricated or ambient prefix');
  const library=readFileSync(environment.BILIKARA_TEST_LIBAV_COMPANION);
  assert.ok(library.length>=64 && library.subarray(0,4).toString('hex')==='7f454c46' && library[4]===2 && library[5]===1 && library.readUInt16LE(16)===3,'BILIKARA_TEST_LIBAV_COMPANION must be an actual native shared ELF');
  assert.equal(library.readUInt16LE(18),process.arch==='arm64'?183:62,'BILIKARA_TEST_LIBAV_COMPANION has incompatible native architecture');
  const executable = await buildNativeHost(), alpha = shared ? await buildNativeAlpha() : undefined;
  const home = mkdtempSync(path.join(root, '.tmp/native browser media 中文 & ')); let fixture;
  const gates = new Map(), stages = [], counts = {}, mediaRequests = [], failures = []; let noDash = false, loginCodes = [0];
  const gate = async (name, seconds) => {
    const state = gates.get(name); if (!state) return; state.started = true;
    await new Promise(resolve => {const timer = setTimeout(resolve, seconds * 1000); state.waiters.push(() => {clearTimeout(timer);resolve();});});
  };
  const release = name => { for (const done of gates.get(name)?.waiters || []) done(); gates.delete(name); };
  const hold = name => { release(name); gates.set(name, {started: false, waiters: []}); };
  try {
    mkdirSync(evidence, {recursive: true}); hold('metadata');
    // FFmpeg is an explicit test oracle/generator, never the child's PATH.
    for (const [file, arguments_] of [
      ['video.mp4', ['-f', 'lavfi', '-i', 'color=c=0x354c62:s=640x360:r=24', '-t', '90', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']],
      ['audio.m4a', ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '90', '-vn', '-c:a', 'aac']],
      ...(policy || bbdown ? [['audio-flac.mp4', ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '90', '-c:a', 'flac', '-strict', '-2']]] : []),
    ]) {
      const built = await runNative('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...arguments_, ...(file==='audio-flac.mp4'?[]:['-movflags','+faststart']), path.join(home, file)], environment, 120000);
      assert.equal(built.status, 0, built.stderr);
    }
    const certs = await localCertificate(path.join(home, 'certs'), ['passport.bilibili.com', 'api.bilibili.com', 'fixture.bilivideo.com', 'api.kevinx96.icu', 'www.bilibili.com', 'api.github.com', 'github.com']);
    const respond = async (raw, headers = {}, payload) => {
      const url = new URL(raw, 'http://fixture.test'), name = url.pathname, query = url.searchParams;
      // Pinned BBDown 1.6.3 checks the canonical AV page with HEAD before
      // fetching metadata. Terminate that request locally, as with every API.
      if (real && name === '/video/av2/') return {fixtureResponse:{rawBody:Buffer.alloc(0),headers:{'Content-Type':'text/html'}}};
      if (name === '/x/passport-login/web/qrcode/generate') {stages.push('generate');return {code:0,data:{url:'https://passport.bilibili.com/scan?fixture=synthetic',qrcode_key:'synthetic-key'}};}
      if (name === '/x/passport-login/web/qrcode/poll') {stages.push('poll');return {fixtureResponse:{data:{code:0,data:{code:loginCodes.length>1?loginCodes.shift():loginCodes[0]}},headers:{'Set-Cookie':['SESSDATA=synthetic-session; Domain=.bilibili.com; Path=/; Secure; HttpOnly','bili_jct=synthetic-csrf; Domain=.bilibili.com; Path=/; Secure','b_nut=synthetic-nut; Domain=.bilibili.com; Path=/; Secure']}}};}
      counts[name]=(counts[name]||0)+1;
      if (name === '/batch-add') {
        assert.deepEqual(Object.keys(payload).sort(), ['records']);
        for (const item of payload.records) assert.deepEqual(Object.keys(item).sort(), ['mid','bvid','title','url','owner_name','owner_url','cover_url'].sort());
        assert.ok(!headers.cookie && !headers.authorization); return {success:true};
      }
      if (name === '/fixture/bbdown-no-dash') {noDash=true;return {};}
      if (name === '/fixture/bbdown-dash') {noDash=false;return {};}
      if (name === '/fixture/cache-stats') return {media:mediaRequests};
      if (name === '/fixture/cache-delay') {hold('media');return {};}
      if (name === '/fixture/cache-release') {release('media');return {};}
      if (name === '/fixture/delayed') return {started:gates.get('metadata')?.started||false};
      if (name === '/fixture/release') {release('metadata');return {};}
      if (name === '/fixture/login-ready') {loginCodes=[0];return {};}
      if (name === '/fixture/login-wait') {loginCodes=[86101];return {};}
      if (name === '/fixture/login-stats') return {generations:stages.filter(stage=>stage==='generate').length};
      if (name === '/x/web-interface/nav') return {code:0,data:{wbi_img:{img_url:'https://i0.hdslb.com/bfs/wbi/'+'a'.repeat(32)+'.png',sub_url:'https://i0.hdslb.com/bfs/wbi/'+'b'.repeat(32)+'.png'}}};
      if (['/x/web-interface/wbi/view','/x/web-interface/view'].includes(name)) {
        const bvid=query.get('bvid')||'BV1xx411c7mD'; if (bvid==='BV1xx411c7mF') await gate('metadata',12);
        const manual=bvid==='BV1xx411c7mE', data={aid:123,bvid,title:'Desktop fixture '+bvid.at(-1),pic:'',owner:{mid:42,name:'Fixture'},pages:[{page:1,cid:456,duration:90,part:manual?'Take A':'on vocal'},{page:2,cid:457,duration:90,part:manual?'Take B':'off vocal'}]};
        if (bbdown) {Object.assign(data,{cid:456,desc:'Synthetic fixture',rights:{is_stein_gate:0},duration:90,pubdate:1,ctime:1});for(const part of data.pages)part.dimension={width:640,height:360};}
        return {code:0,data};
      }
      // Public owner/imported-source profile enrichment; never a library crawl.
      if (name === '/x/space/wbi/acc/info' && ['42','123','456'].includes(query.get('mid'))) return {code:0,data:{mid:Number(query.get('mid')),name:'Fixture',face:''}};
      // Imported credentials may refresh the one explicitly imported source.
      // Empty local data never produces review records or forwards a request.
      if ((policy || bbdown) && name === '/x/space/wbi/arc/search' && query.get('mid') === '123') return {code:0,data:{list:{vlist:[]}}};
      if (['/x/player/wbi/playurl','/x/player/playurl'].includes(name)) {
        if(noDash)return {code:0,data:{durl:[{url:'https://fixture.bilivideo.com/segmented.flv',order:1},{url:'https://fixture.bilivideo.com/segmented2.flv',order:2}]}};
        const data={quality:64,dash:{video:[{id:64,codecid:7,bandwidth:100000,baseUrl:'https://fixture.bilivideo.com/video.mp4',mimeType:'video/mp4',codecs:'avc1.64001e'}],audio:[{id:30280,bandwidth:128000,baseUrl:'https://fixture.bilivideo.com/audio.m4a',mimeType:'audio/mp4',codecs:'mp4a.40.2'}]}};
        if (real) {Object.assign(data,{timelength:90000,accept_quality:[64],accept_description:['720P 高清']});data.dash.duration=90;for(const kind of ['video','audio'])for(const stream of data.dash[kind])Object.assign(stream,{base_url:stream.baseUrl,backupUrl:[],backup_url:[],width:640,height:360,frameRate:'24',frame_rate:'24',duration:90});}
        if (policy) {data.dash.video=[116,80,64,32,16].flatMap(quality=>[7,12].map(codec=>({id:quality,codecid:codec,bandwidth:100000,baseUrl:`https://fixture.bilivideo.com/video.mp4?q=${quality}&codec=${codec}`,mimeType:'video/mp4',codecs:codec===7?'avc1.64001e':'hev1.1.6.L93.B0'})));data.dash.flac={audio:{id:30251,baseUrl:'https://fixture.bilivideo.com/audio-flac.mp4',mimeType:'audio/mp4',codecs:'fLaC'}};}
        return {code:0,data};
      }
      if (['/video.mp4','/audio.m4a','/audio-flac.mp4'].includes(name)) {
        mediaRequests.push({path:name,quality:query.get('q')||'',codec:query.get('codec')||''}); if (policy && name==='/video.mp4') await gate('media',10);
        let body=readFileSync(path.join(home,name.slice(1))),status=200; const resultHeaders={'Accept-Ranges':'bytes'};
        if (headers.range) {const match=headers.range.match(/^bytes=(\d+)-(\d*)$/);assert.ok(match);const first=Number(match[1]),last=match[2]?Number(match[2]):body.length-1;resultHeaders['Content-Range']=`bytes ${first}-${last}/${body.length}`;body=body.subarray(first,last+1);status=206;}
        return {fixtureResponse:{status,rawBody:body,headers:resultHeaders}};
      }
      if (['/bilikara/releases','/bilikara/releases/latest'].includes(name)) {
        const release_={tag_name:'v0.8.1',draft:false,prerelease:false,name:'bilikara v0.8.1',html_url:'https://github.com/VZRXS/bilikara/releases/tag/v0.8.1',assets:[{name:'bilikara-v0.8.1-windows-x64.zip',label:'',content_type:'application/zip',browser_download_url:'https://github.com/VZRXS/bilikara/releases/download/v0.8.1/bilikara-v0.8.1-windows-x64.zip'},{name:'bilikara-v0.8.1-android-arm64.apk',label:'',content_type:'application/vnd.android.package-archive',browser_download_url:'https://github.com/VZRXS/bilikara/releases/download/v0.8.1/bilikara-v0.8.1-android-arm64.apk'}]};
        return name.endsWith('/latest')?release_:[release_];
      }
      if (['/api/catalog/search','/search','/api/search'].includes(name)) return [{title:'Desktop fixture catalog',bvid:'BV1xx411c7mD',url:'https://www.bilibili.com/video/BV1xx411c7mD'}];
      if (['rating','space/wbi','gviz','d1/'].some(value=>name.includes(value))) failures.push(name);
      return {fixtureResponse:{status:503,data:{error:'offline fixture: unsupported external request'}}};
    };
    fixture = await videoFixture((raw,headers)=>respond(raw,headers),certs, async(request,body)=>{const result=await respond(request.url,request.headers,body);return result.fixtureResponse??{data:result};});
    const playwright = createRequire(import.meta.url)('playwright');
    const env={...isolatedEnvironment(home),...fixture.environment,PATH:environment.PATH,NO_PROXY:'127.0.0.1,localhost',no_proxy:'127.0.0.1,localhost',BILIKARA_TEST_NATIVE_HOST:executable,BILIKARA_TEST_NATIVE_ALPHA:alpha,
      BILIKARA_VERSION:'0.8.0',BILIKARA_CATALOG_SHEETS_URL:'http://127.0.0.1:1/disabled.csv',DESKTOP_FIXTURE_CONTROL:fixture.base,
      BILIKARA_TEST_APPLICATION_PATH:path.join(home,'empty-path'),BILIKARA_TEST_BROWSER_DATA_DIR:path.join(home,'native-data'),
      BILIKARA_BROWSER_EXECUTABLE:environment.BILIKARA_BROWSER_EXECUTABLE||playwright[shared?(environment.BILIKARA_TEST_BROWSER||'firefox'):'webkit'].executablePath(),
      BILIKARA_TEST_BROWSER:shared?(environment.BILIKARA_TEST_BROWSER||'firefox'):undefined,BILIKARA_TEST_ACTIVE_PITCH:environment.BILIKARA_TEST_ACTIVE_PITCH};
    if(policy)env.BILIKARA_CACHE_POLICY_FIXTURE='1';
    if(bbdown) {
      const folder=path.join(home,'BBDown fixture 空');mkdirSync(folder);
      let tool=path.join(folder,'BBDown');if(real){tool=path.resolve(environment.BILIKARA_TEST_BBDOWN_PATH||'');assert.ok(existsSync(tool)&&environment.BILIKARA_TEST_BBDOWN_PATH,'declare actual pinned native BBDown for --bbdown-real');env.BILIKARA_BBDOWN_REAL='1';}
      else {
        const source=path.join(root,'tests/bbdown_fixture.rs');
        const compile=await runNative('rustc',['--edition=2024','--target',nativeTarget(),'--crate-name','bbdown_fixture',source,'-o',tool],environment);assert.equal(compile.status,0,compile.stderr);
        const bytes=readFileSync(tool);writeFileSync(path.join(evidence,'bbdown-fixture-image'),bytes);
        writeFileSync(path.join(evidence,'bbdown-fixture-source.json'),JSON.stringify({source,target:nativeTarget(),executable:tool,source_sha256:createHash('sha256').update(readFileSync(source)).digest('hex'),image_sha256:createHash('sha256').update(bytes).digest('hex')},null,2));
      }
      Object.assign(env,{BILIKARA_BBDOWN_FIXTURE:tool,BILIKARA_BBDOWN_FIXTURE_ROOT:folder,BILIKARA_BBDOWN_MEDIA:home});writeFileSync(path.join(folder,'mode'),'slow');
    }
    const driver=shared?'tests/browser/shared_native_host.cjs':policy||bbdown?'tests/live_desktop_import.js':'tests/live_desktop_rust_host.js';
    const checked=await runNative(process.execPath,[driver,path.resolve(evidence)],env,240000);
    writeFileSync(path.join(evidence,'browser.stdout.log'),checked.stdout);writeFileSync(path.join(evidence,'browser.stderr.log'),checked.stderr);
    writeFileSync(path.join(evidence,'fixture-summary.json'),JSON.stringify({request_counts:counts,login_stages:stages,forwarded_external_requests:0},null,2));
    assert.equal(checked.status,0,checked.stdout+checked.stderr);
    assert.deepEqual(failures,[]);if(policy||real)assert.deepEqual(stages,[],'cache tests must not login');else {assert.ok(stages.includes('generate'));assert.ok(stages.includes('poll'));}
    if (existsSync(path.join(evidence,'diagnostics.zip'))) {
      const entries=zipEntries(readFileSync(path.join(evidence,'diagnostics.zip')));
      for(const name of ['diagnostics.md','runtime-state.json','system.json','download-policy.json','connectivity.json'])assert.ok(entries.has(name),name);
      const payload=Buffer.concat([...entries.values()]);for(const secret of ['synthetic-session','Desktop Fixture','BBDown.data','/bootstrap/'])assert.ok(!payload.includes(Buffer.from(secret)));
      const download=JSON.parse(entries.get('download-policy.json'));assert.equal(download.video_quality,'1080P 高帧率');assert.equal(download.audio_hires,true);
    }
    writeFileSync(path.join(evidence,'fixture-summary.json'),JSON.stringify({request_counts:counts,login_stages:stages,forwarded_external_requests:0},null,2));
    return checked;
  } finally {for(const name of [...gates.keys()])release(name);if(fixture)await fixture.close();rmSync(home,{recursive:true,force:true});}
}
if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.ok(process.argv[2],'usage: run_desktop_rust_host.mjs EVIDENCE_DIRECTORY [--shared-ui|--cache-policy|--bbdown|--bbdown-real]');
  const result=await runDesktopBrowser(path.resolve(process.argv[2]),process.argv.slice(3));process.stdout.write(result.stdout);process.stderr.write(result.stderr);
}
