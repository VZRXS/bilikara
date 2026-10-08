// Explicit, offline Linux integration gate. No production endpoint is contacted.
// Browser plugin not available; reuse pinned Playwright and the actual native Host.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHmac, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from './desktop_construction_support.mjs';
import { buildNativeHost } from './native_runtime_artifacts.mjs';
import { TransportFixture } from './native_transport_support.mjs';
import { localCertificate } from './local_tls_certificate.mjs';

const require = createRequire(import.meta.url), { chromium } = require('playwright');
const { wsServer } = require(path.join(root, 'node_modules/playwright-core/lib/utilsBundle.js'));
const script = fileURLToPath(import.meta.url);
const outputIndex=process.argv.indexOf('--output');
const output = path.resolve(outputIndex>=0?process.argv[outputIndex + 1]:'.tmp/internet-remote-relay');
const tools = process.env.BILIKARA_RELAY_TOOLS || path.join(root, '.tmp/internet-remote-relay-tools');
const turnserver = process.env.BILIKARA_TEST_TURNSERVER || path.join(tools, 'usr/bin/turnserver');
const iptables = process.env.BILIKARA_TEST_IPTABLES || path.join(tools, 'usr/sbin/iptables-nft');
const ip6tables = process.env.BILIKARA_TEST_IP6TABLES || path.join(tools, 'usr/sbin/ip6tables-nft');
const certutil = process.env.BILIKARA_TEST_CERTUTIL || path.join(tools, 'usr/bin/certutil');
const environment = { ...process.env, LD_LIBRARY_PATH: [path.join(tools, 'usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'), XTABLES_LIBDIR: path.join(tools, 'usr/lib/x86_64-linux-gnu/xtables') };
function command(file, args, options = {}) {
  const result = spawnSync(file, args, { env: environment, encoding: 'utf8', timeout: 12000, ...options });
  assert.equal(result.status, 0, `${file}: ${result.stderr || result.error || result.stdout}`);
  return result.stdout;
}
function child(file, args, options = {}) {
  const process = spawn(file, args, { env: environment, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  process.output = ''; process.stdout?.on('data', data => { if (process.output.length < 131072) process.output += data.toString(); });
  process.stderr?.on('data', data => { if (process.output.length < 131072) process.output += data.toString(); });
  process.finished = new Promise(resolve => process.once('close', (status, signal) => resolve({status,signal})));
  return process;
}
const enter = (pid, file, args) => command('nsenter', ['-t', String(pid), '-n', file, ...args]);
const firewall = (...args) => command(iptables, args);
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const sanitized=value=>String(value).replace(/\/bootstrap\/[A-Za-z0-9_-]+/gu,'/bootstrap/[redacted]').replaceAll('test-pass','[redacted]');

if (!process.argv.includes('--isolated')) {
  assert.equal(process.platform, 'linux', 'native relay requires Linux user/network namespaces');
  for (const file of [turnserver, iptables, ip6tables, certutil, chromium.executablePath()]) assert.ok(existsSync(file), `Missing relay prerequisite: ${file}; see docs/internet-remote-network.md. Explicit relay tests never silently skip.`);
  command('unshare', ['--user', '--map-root-user', '--net', 'true']);
  assert.match(command('strings', [turnserver]), /Coturn-4\.5\.2/u, 'tested coturn version must remain pinned');
  mkdirSync(output, {recursive:true});
  process.env.CARGO_NET_OFFLINE = 'true';
  const executable = process.env.BILIKARA_RELAY_HOST || await buildNativeHost();
  assert.ok(existsSync(executable),'actual prepared native Host is required');
  const isolated = child('unshare', ['--user', '--map-root-user', '--net', process.execPath, script, '--isolated', '--output', output], {env:{...environment,BILIKARA_RELAY_HOST:executable},detached:true});
  isolated.stdout.on('data',data=>process.stdout.write(data));
  const deadline = setTimeout(() => {try{process.kill(-isolated.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}, 240000);
  const result = await isolated.finished; clearTimeout(deadline);
  writeFileSync(path.join(output,'runner.log'), sanitized(isolated.output));
  assert.equal(result.status, 0, sanitized(isolated.output));
  console.log('Actual isolated native relay matrix: PASS');
} else {
  await run();
}

async function run() {
  mkdirSync(output, {recursive:true});
  const owned=mkdtempSync(path.join(output,'owned-'));
  const resources = [], peers = [], sockets = new Set(), counters = {http:0,websocketConnections:0,signals:0,iceConfigs:0,externalBrowserRequests:0};
  let fixture, service, relay;
  const checks = [], report = {passed:false,scope:'three disposable network namespaces; real Chromium/WebRTC; actual native Host; narrow signaling contract fixture, not deployed Worker code',browserPlugin:'absent; pinned Playwright',coturnVersion:'4.5.2-3.1~ubuntu22.04.1',nativeHostSha256:createHash('sha256').update(readFileSync(process.env.BILIKARA_RELAY_HOST)).digest('hex'),checks,counters};
  try {
    command('ip',['link','set','lo','up']);
    command('ip',['link','add','service','type','dummy']);
    command('ip',['link','set','service','addrgenmode','none']);
    command('ip',['addr','add','10.77.0.1/24','dev','service']);
    command('ip',['link','set','service','up']);
    firewall('-P','FORWARD','DROP');
    firewall('-A','OUTPUT','-d','127.0.0.0/8','-j','ACCEPT');
    firewall('-A','OUTPUT','-d','10.77.0.0/16','-j','ACCEPT');
    firewall('-A','OUTPUT','-j','DROP');
    command(ip6tables,['-P','OUTPUT','DROP']); command(ip6tables,['-P','FORWARD','DROP']);
    for (let index=1;index<=2;index++) {
      const hold = child('unshare',['--net','sleep','240']); resources.push(hold); await delay(50);
      assert.equal(hold.exitCode,null,'peer namespace prerequisite'); peers.push(hold);
      command('ip',['link','add',`edge${index}`,'type','veth','peer','name',`peer${index}`]);
      command('ip',['link','set',`peer${index}`,'netns',String(hold.pid)]);
      command('ip',['link','set',`edge${index}`,'addrgenmode','none']);
      command('ip',['addr','add',`10.77.${index}.1/24`,'dev',`edge${index}`]);
      command('ip',['link','set',`edge${index}`,'up']);
      enter(hold.pid,'ip',['link','set','lo','up']);
      enter(hold.pid,'ip',['link','set',`peer${index}`,'addrgenmode','none']);
      enter(hold.pid,'ip',['addr','add',`10.77.${index}.2/24`,'dev',`peer${index}`]);
      enter(hold.pid,'ip',['link','set',`peer${index}`,'up']);
      enter(hold.pid,'ip',['route','add','default','via',`10.77.${index}.1`]);
      enter(hold.pid,ip6tables,['-P','OUTPUT','DROP']); enter(hold.pid,ip6tables,['-P','FORWARD','DROP']);
    }
    // readlink rather than interface labels proves separate stacks.
    report.namespaces = command('readlink',[`/proc/${process.pid}/ns/net`,...peers.map(peer=>`/proc/${peer.pid}/ns/net`)]).trim().split('\n');
    assert.equal(new Set(report.namespaces).size,3);
    assert.equal(command('ip',['route','show','default']).trim(),'','service namespace has no route to workstation/Internet');
    command('ip',['route','add','203.0.113.1/32','dev','service']);
    command(process.execPath,['-e',"const socket=require('node:dgram').createSocket('udp4');socket.send('egress-proof',9,'203.0.113.1',()=>socket.close())"]);
    fixture = await TransportFixture.start(process.env.BILIKARA_RELAY_HOST);
    const certs = await localCertificate(path.join(owned,'certs'),['relay.test']);
    const secret = randomBytes(32).toString('base64url');
    const config = path.join(owned,'turnserver.conf');
    writeFileSync(config,[
      'listening-ip=10.77.0.1','relay-ip=10.77.0.1','listening-port=3478','tls-listening-port=5349','min-port=49160','max-port=49175',
      'realm=bilikara-local.test','use-auth-secret',`static-auth-secret=${secret}`,'fingerprint','no-cli','no-dtls','no-tlsv1','no-tlsv1_1','no-multicast-peers','no-loopback-peers',
      'user-quota=2','total-quota=8','max-bps=65536','bps-capacity=524288',`cert=${path.join(certs,'cert.pem')}`,`pkey=${path.join(certs,'key.pem')}`,
      'denied-peer-ip=0.0.0.0-255.255.255.255','allowed-peer-ip=10.77.0.1-10.77.2.2',
      'no-software-attribute','log-file=stdout','simple-log',`pidfile=${path.join(owned,'coturn.pid')}`,
    ].join('\n')+'\n',{mode:0o600});
    relay = child(turnserver,['-c',config]); resources.push(relay); await delay(400); assert.equal(relay.exitCode,null,relay.output);
    const lanes = new Map(); let currentCase;
    service = http.createServer(async (request,response) => {
      counters.http++;
      const pathname = new URL(request.url,'http://localhost').pathname;
      if (pathname === '/v1/rooms' && request.method === 'POST') { for await (const _ of request) {} response.setHeader('content-type','application/json'); return response.end(JSON.stringify({room_id:'R'.repeat(27),created_at:Date.now(),expires_at:Date.now()+3600000})); }
      if (pathname.startsWith('/v1/rooms/') && request.method === 'DELETE') {response.writeHead(204);return response.end();}
      if (pathname === '/remote.html') return staticFile('remote.html',response);
      if (/^\/[a-z0-9_.-]+\.(?:js|css|json)$/iu.test(pathname) && existsSync(path.join(root,'static',pathname.slice(1)))) return staticFile(pathname.slice(1),response);
      if (pathname.startsWith('/static/')) {
        const name = pathname.slice(8); assert.match(name,/^[a-z0-9_.-]+$/iu);
        return staticFile(name,response);
      }
      const headers = {...request.headers,host:new URL(fixture.host.base).host,origin:fixture.host.base};
      const proxy = http.request(new URL(request.url,fixture.host.base),{method:request.method,headers},upstream=>{response.writeHead(upstream.statusCode,upstream.headers);upstream.pipe(response);});
      proxy.on('error',()=>{response.writeHead(502);response.end();}); request.pipe(proxy);
    });
    function staticFile(name,response) {
      const from = currentCase?.before && ['internet-remote-host.js','remote-transport-client.js','internet-remote-transport.js'].includes(name) ? path.join(output,'before-assets',name) : path.join(root,'static',name);
      let bytes = readFileSync(from);
      if (name === 'internet-remote-host.js') bytes=Buffer.from(bytes.toString('utf8').replaceAll('https://rtc.kevinx96.icu',`http://127.0.0.1:${port}`));
      if (name === 'internet-remote-transport.js') bytes=Buffer.from(bytes.toString('utf8').replace('stun:stun.cloudflare.com:3478','stun:10.77.0.1:3478'));
      response.setHeader('content-type',name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.html')?'text/html':'application/octet-stream');response.end(bytes);
    }
    service.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
    await new Promise(resolve=>service.listen(0,'10.77.0.1',resolve));const port=service.address().port;
    const wss = new wsServer({server:service,handleProtocols:()=> 'bilikara-v1'});
    wss.on('connection',(socket,request)=>{
      counters.websocketConnections++;
      const auth=String(request.headers['sec-websocket-protocol']).split(',').map(value=>value.trim()).find(value=>/^(host|remote)\./u.test(value));
      assert.ok(auth);const [role,,peerId]=auth.split('.');lanes.set(role,socket);socket.peerId=peerId;
      if (currentCase.turn) {
        const expires=Math.floor(Date.now()/1000)+300, username=`${expires}:fixture:${role}:${peerId}`;
        const credential=currentCase.invalid?'invalid':createHmac('sha1',secret).update(username).digest('base64');
        const scheme=currentCase.protocol==='tls'?'turns':'turn'; const turnPort=currentCase.unavailable?3499:currentCase.protocol==='tls'?5349:3478;
        const url=`${scheme}:${currentCase.protocol==='tls'?'relay.test':'10.77.0.1'}:${turnPort}?transport=${currentCase.protocol==='udp'?'udp':'tcp'}`;
        socket.send(JSON.stringify({type:'ice.config',payload:{expires_at:expires*1000,ice_servers:[{urls:[url],username,credential}]}}));counters.iceConfigs++;
      }
      const host=lanes.get('host'),remote=lanes.get('remote');if(host?.readyState===1&&remote?.readyState===1)host.send(JSON.stringify({type:'peer.join',peer_id:remote.peerId}));
      socket.on('message',wire=>{counters.signals++;const message=JSON.parse(wire);const target=lanes.get(role==='host'?'remote':'host');if(target?.readyState===1)target.send(JSON.stringify({type:message.type,from:peerId,payload:message.payload}));});
      socket.on('close',()=>{if(lanes.get(role)===socket)lanes.delete(role);});
    });
    for (const peer of peers) {
      const gateway=child('nsenter',['-t',String(peer.pid),'-n',process.execPath,path.join(root,'tests/native_relay_gateway.mjs'),String(port)]);resources.push(gateway);await delay(80);assert.equal(gateway.exitCode,null,gateway.output);
      const probe=child('nsenter',['-t',String(peer.pid),'-n',process.execPath,'-e',"require('node:net').createServer(socket=>socket.pipe(socket)).listen(49900,'0.0.0.0');const udp=require('node:dgram').createSocket('udp4');udp.on('message',(data,from)=>udp.send(data,from.port,from.address));udp.bind(49900,'0.0.0.0')"]);resources.push(probe);await delay(50);assert.equal(probe.exitCode,null,probe.output);
    }
    const cases = [
      ...(existsSync(path.join(output,'before-assets/internet-remote-host.js')) ? [{name:'A-before',direct:true,before:true}] : []),
      {name:'A',direct:true},{name:'B',success:false},{name:'C',turn:true,protocol:'udp'},
      {name:'D-TCP',turn:true,protocol:'tcp',noUdp:true},{name:'D-TLS',turn:true,protocol:'tls',noUdp:true},
      {name:'E-invalid',turn:true,protocol:'udp',invalid:true,success:false},{name:'E-unavailable',turn:true,protocol:'udp',unavailable:true,success:false},
    ];
    const selectedCases=process.env.BILIKARA_RELAY_CASES?.split(',');
    if(selectedCases)assert.ok(selectedCases.length&&selectedCases.every(name=>cases.some(value=>value.name===name)),'unknown explicit relay matrix case');
    for (const value of cases.filter(value=>!selectedCases||selectedCases.includes(value.name))) {
      currentCase=value;firewall('-F','FORWARD');
      if(value.direct){firewall('-A','FORWARD','-s','10.77.1.2','-d','10.77.2.2','-j','ACCEPT');firewall('-A','FORWARD','-s','10.77.2.2','-d','10.77.1.2','-j','ACCEPT');}
      firewall('-A','FORWARD','-j','DROP');
      for (const peer of peers) {enter(peer.pid,iptables,['-F','OUTPUT']);if(value.noUdp)enter(peer.pid,iptables,['-A','OUTPUT','-p','udp','-j','DROP']);}
      const row={name:value.name,policy:'all',directAllowed:Boolean(value.direct),udpAllowed:!value.noUdp,passed:false};checks.push(row);
      row.directProbes=peers.map((peer,index)=>JSON.parse(enter(peer.pid,process.execPath,['-e',`const target='10.77.${index?1:2}.2',out={tcp:false,udp:false};const tcp=require('node:net').connect(49900,target,()=>{out.tcp=true;tcp.destroy()});tcp.on('error',()=>{});const udp=require('node:dgram').createSocket('udp4');udp.on('message',()=>{out.udp=true});udp.send('probe',49900,target);setTimeout(()=>{tcp.destroy();udp.close();console.log(JSON.stringify(out))},300)`])));
      for(const probe of row.directProbes){assert.equal(probe.tcp,Boolean(value.direct));assert.equal(probe.udp,Boolean(value.direct));}
      try {await browserCase(value,row,port,certs);} catch(error) {row.error=sanitized(error.stack);throw error;}
      row.firewall=firewall('-L','FORWARD','-n','-v','-x');row.peerOutput=peers.map(peer=>enter(peer.pid,iptables,['-L','OUTPUT','-n','-v','-x']));
      await delay(200);assert.equal(lanes.size,0,'signaling sockets retire after closing owned browser contexts');
      const countRelayPorts=()=>readFileSync('/proc/net/udp','utf8').trim().split('\n').slice(1).filter(line=>{const port=Number.parseInt(line.trim().split(/\s+/u)[1].split(':')[1],16);return port>=49160&&port<=49175;}).length;
      const cleanupStarted=performance.now(),cleanupDeadline=cleanupStarted+12000;
      while(countRelayPorts()&&performance.now()<cleanupDeadline)await delay(100);
      row.relayCleanupMs=Math.round(performance.now()-cleanupStarted);row.remainingRelayUdpPorts=countRelayPorts();
      assert.equal(row.remainingRelayUdpPorts,0,'graceful product teardown leaves no relay allocation sockets');
      row.passed=true;
      console.log(`${value.name}: PASS ${JSON.stringify({elapsedMs:row.elapsedMs,pair:row.pair,failure:row.failure})}`);
    }
    report.egress={defaultRoute:command('ip',['route','show','default']).trim(),output:firewall('-L','OUTPUT','-n','-v','-x'),ipv6:command(ip6tables,['-L','OUTPUT','-n','-v','-x']),interfaces:command('ip',['-br','addr']),providerRequests:fixture.provider.requests.length};
    assert.match(report.egress.output,/\b1\s+\d+\s+DROP/u,'the enforced Internet drop rule must count an intentional TEST-NET probe');
    assert.equal(counters.externalBrowserRequests,0,'all browser resources must be explicitly local');
    report.passed=true;
  } catch(error) {report.error=sanitized(error.stack);throw error;} finally {
    for(const socket of sockets)socket.destroy(); if(service)await new Promise(resolve=>service.close(resolve));
    for(const resource of [...resources].reverse()){resource.kill('SIGTERM');await Promise.race([resource.finished,delay(1000)]);if(resource.exitCode===null)resource.kill('SIGKILL');}
    if(fixture)await fixture.close();
    report.cleanup={childrenExited:resources.every(resource=>resource.exitCode!==null||resource.signalCode!==null),fixtureClosed:Boolean(fixture)};
    writeFileSync(path.join(output,'matrix.json'),JSON.stringify(report,null,2));
    rmSync(owned,{recursive:true,force:true});
  }

  async function browserCase(value,row,port,certs) {
    const browsers=[],contexts=[],pages=[];const errors=[];
    const start=performance.now();
    try {
      for(let index=0;index<2;index++) {
        const home=path.join(owned,`${value.name}-${index}`);mkdirSync(path.join(home,'.pki/nssdb'),{recursive:true});
        command(certutil,['-N','--empty-password','-d',`sql:${path.join(home,'.pki/nssdb')}`]);
        command(certutil,['-A','-d',`sql:${path.join(home,'.pki/nssdb')}`,'-n','owned-relay-test-ca','-t','C,,','-i',path.join(certs,'ca.pem')]);
        const wrapper=path.join(home,'chromium');writeFileSync(wrapper,`#!/bin/sh\nexec nsenter -t ${peers[index].pid} -n ${shellQuote(chromium.executablePath())} "$@"\n`);chmodSync(wrapper,0o700);
        const browser=await chromium.launch({executablePath:wrapper,headless:true,env:{...environment,HOME:home},args:['--no-sandbox','--disable-background-networking','--disable-features=MediaRouter','--host-resolver-rules=MAP relay.test 10.77.0.1,MAP * ~NOTFOUND,EXCLUDE localhost,EXCLUDE 127.0.0.1,EXCLUDE 10.77.0.1']});browsers.push(browser);
        const context=await browser.newContext({viewport:index?{width:390,height:844}:{width:1100,height:800}});contexts.push(context);
        await context.addInitScript(()=> {
          const NativePeer=globalThis.RTCPeerConnection;
          globalThis.__relayTestPeers=[];
          globalThis.__relayTestChannels=[];globalThis.__relayTestSockets=[];
          globalThis.RTCPeerConnection=class extends NativePeer {constructor(configuration){super(configuration);globalThis.__relayTestPeers.push(this);this.addEventListener('datachannel',event=>globalThis.__relayTestChannels.push(event.channel));}};
          const NativeSocket=globalThis.WebSocket;globalThis.WebSocket=class extends NativeSocket {constructor(...args){super(...args);globalThis.__relayTestSockets.push(this);}};
          const timeouts=new Set(),intervals=new Set();globalThis.__relayTestTimers={timeouts,intervals};
          const timeout=globalThis.setTimeout,interval=globalThis.setInterval,clearTimeout=globalThis.clearTimeout,clearInterval=globalThis.clearInterval;
          globalThis.setTimeout=function(callback,ms,...args){let id;const owned=/remote-transport-client\.js/u.test(new Error().stack||'');id=timeout(function(...values){timeouts.delete(id);callback.apply(this,values);},ms,...args);if(owned)timeouts.add(id);return id;};
          globalThis.clearTimeout=function(id){timeouts.delete(id);return clearTimeout(id);};
          globalThis.setInterval=function(callback,ms,...args){const id=interval(callback,ms,...args);if(/remote-transport-client\.js/u.test(new Error().stack||''))intervals.add(id);return id;};
          globalThis.clearInterval=function(id){intervals.delete(id);return clearInterval(id);};
        });
        await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.hostname!=='127.0.0.1'){counters.externalBrowserRequests++;return route.abort('blockedbyclient');}return route.continue();});
        const page=await context.newPage();pages.push(page);page.on('pageerror',error=>errors.push(error.message));
        if(index===0) {
          await page.goto(`http://127.0.0.1:${port}${new URL(fixture.host.bootstrapUrl).pathname}`);
          await page.waitForFunction(()=>globalThis.BilikaraInternetRemoteDiagnostics);
        } else await page.goto(`http://127.0.0.1:${port}/remote.html#room=${'R'.repeat(27)}&join=${'J'.repeat(43)}&expires=${Date.now()+3_600_000}`);
      }
      const [host,remote]=pages;
      await host.locator('#remote-mini-trigger').click();
      if(await host.locator('#internet-remote-disclosure').getAttribute('aria-expanded')!=='true')await host.locator('#internet-remote-disclosure').click();
      await host.locator('#internet-remote-password').fill('test-pass');
      await host.locator('#internet-remote-restart').click();
      await remote.locator('#internet-join-identity').fill('Fixture ID');await remote.locator('#internet-join-password').fill('test-pass');
      const joinedAt=performance.now();await remote.locator('.internet-remote-join-card button[type=submit]').click();
      if(value.success===false) {
        await remote.waitForFunction(()=>document.querySelector('.internet-remote-join-card button')?.disabled===false && [...document.querySelectorAll('body *')].some(node=>node.childElementCount===0&&/连接.*失败|无法.*连接|网络.*限制/u.test(node.textContent||'')),{},{timeout:40000});
        row.elapsedMs=Math.round(performance.now()-joinedAt);row.failure=await remote.evaluate(()=>globalThis.BilikaraInternetRemoteDiagnostics?.getSnapshot?.()||null);
        assert.ok(['transport_failed','transport_timeout'].includes(row.failure?.failure_code),'restricted paths fail as transport, never as wrong password or ready');
        await remote.screenshot({path:path.join(output,`${value.name}-remote.png`)});
        // Local controls remain usable, no automatic mutation submission.
        const before=await fixture.state();await fixture.host.api('/api/player/av-delay-action',{type:'adjust',delta_ms:50});const after=await fixture.state();assert.equal(after.player_settings.av_offset_ms,before.player_settings.av_offset_ms+50);
        const beforeConnections=counters.websocketConnections;await delay(4000);
        assert.equal(counters.websocketConnections,beforeConnections,'failed join does not enter an automatic reconnect loop');
        row.failedResources=await remote.evaluate(()=>({peers:__relayTestPeers.map(peer=>peer.connectionState),channels:__relayTestChannels.map(channel=>channel.readyState),sockets:__relayTestSockets.map(socket=>socket.readyState),timeouts:__relayTestTimers.timeouts.size,intervals:__relayTestTimers.intervals.size}));
        assert.ok(row.failedResources.peers.every(state=>state==='closed'));assert.ok(row.failedResources.channels.every(state=>state==='closed'));assert.ok(row.failedResources.sockets.every(state=>state===3));assert.equal(row.failedResources.timeouts,0);assert.equal(row.failedResources.intervals,0);
      } else {
        await remote.locator('.internet-remote-join-overlay').waitFor({state:'hidden',timeout:30000});
        row.elapsedMs=Math.round(performance.now()-joinedAt);
        row.pair=await remote.evaluate(async()=> {
          const peer=globalThis.__relayTestPeers.findLast(peer=>peer.connectionState==='connected');
          const stats=await peer.getStats();
          const transport=[...stats.values()].find(stat=>stat.type==='transport'&&stat.selectedCandidatePairId);
          const pair=transport?stats.get(transport.selectedCandidatePairId):[...stats.values()].find(stat=>stat.type==='candidate-pair'&&stat.nominated&&stat.state==='succeeded');
          const select=candidate=>candidate?{type:candidate.candidateType||'unknown',protocol:candidate.protocol||'unknown',relayProtocol:candidate.relayProtocol||'unknown'}:null;
          return {nominated:pair?.nominated===true,state:pair?.state||'unknown',local:select(stats.get(pair?.localCandidateId)),remote:select(stats.get(pair?.remoteCandidateId)),bytesSent:pair?.bytesSent||0,bytesReceived:pair?.bytesReceived||0,lanes:[...globalThis.__relayTestPeers].filter(peer=>peer.connectionState==='connected').length};
        });
        assert.equal(row.pair.state,'succeeded');assert.equal(row.pair.nominated,true);
        if(value.turn)assert.ok([row.pair.local?.type,row.pair.remote?.type].includes('relay'),'actual selected pair must contain a relay candidate');
        row.channels=await remote.evaluate(()=>__relayTestChannels.map(channel=>({label:channel.label,ordered:channel.ordered,state:channel.readyState})).sort((a,b)=>a.label.localeCompare(b.label)));
        assert.deepEqual(row.channels,[{label:'bilikara-bulk',ordered:true,state:'open'},{label:'bilikara-control',ordered:true,state:'open'}]);
        row.diagnostic=await remote.evaluate(()=>globalThis.BilikaraInternetRemoteDiagnostics?.getSnapshot?.()||null);
        const before=await fixture.state();
        await remote.locator('#playback-dock').click();
        await remote.locator('#remote-av-sync-panel [data-av-step="50"]').waitFor({state:'visible'});
        const commandAt=performance.now();
        await remote.locator('#remote-av-sync-panel [data-av-step="50"]').click();
        const expected=before.player_settings.av_offset_ms+50;
        await remote.locator('#remote-av-offset-input').waitFor({state:'visible'});
        await remote.waitForFunction(expected=>Number(document.querySelector('#remote-av-offset-input')?.value)===expected,expected);
        const state=await fixture.state();row.resultingAvDelay=state.player_settings.av_offset_ms;assert.equal(row.resultingAvDelay,expected);row.remoteRenderedAvDelay=await remote.locator('#remote-av-offset-input').inputValue();
        row.commandFeedbackMs=Math.round(performance.now()-commandAt);
        row.exchangeAfterCommand=await remote.evaluate(async()=>{const peer=__relayTestPeers.findLast(peer=>peer.connectionState==='connected'),stats=await peer.getStats(),transport=[...stats.values()].find(row=>row.type==='transport'&&row.selectedCandidatePairId),pair=transport?stats.get(transport.selectedCandidatePairId):null;return {localType:stats.get(pair?.localCandidateId)?.candidateType||'unknown',remoteType:stats.get(pair?.remoteCandidateId)?.candidateType||'unknown',bytesSent:pair?.bytesSent||0,bytesReceived:pair?.bytesReceived||0};});
        assert.ok(row.exchangeAfterCommand.bytesSent>row.pair.bytesSent);assert.ok(row.exchangeAfterCommand.bytesReceived>row.pair.bytesReceived);
        if(value.turn)assert.ok([row.exchangeAfterCommand.localType,row.exchangeAfterCommand.remoteType].includes('relay'));
        if(value.turn) await remote.screenshot({path:path.join(output,`${value.name}-remote.png`)});
        if(value.name==='C') await host.screenshot({path:path.join(output,'C-host.png'),mask:[host.locator('#internet-remote-url'),host.locator('#internet-remote-qr'),host.locator('#internet-remote-current-password-value'),host.locator('#internet-remote-password')]});
      }
      row.totalMs=Math.round(performance.now()-start);row.errors=errors;assert.deepEqual(errors,[]);
    } catch(error) {
      row.browserStates=await Promise.all(pages.map(page=>page.evaluate(()=>({title:document.title,status:document.querySelector('#remote-connection-status')?.textContent,diagnostic:globalThis.BilikaraInternetRemoteDiagnostics?.getSnapshot?.()||null,peers:globalThis.__relayTestPeers.map(peer=>({connection:peer.connectionState,ice:peer.iceConnectionState,gathering:peer.iceGatheringState}))})).catch(()=>null)));
      for(let index=0;index<pages.length;index++)await pages[index].screenshot({path:path.join(output,`${value.name}-failure-${index}.png`),mask:[pages[index].locator('#internet-remote-url'),pages[index].locator('#internet-remote-qr'),pages[index].locator('#internet-remote-current-password-value'),pages[index].locator('#internet-remote-password')]}).catch(()=>{});
      throw error;
    } finally {
      if(pages[1])await pages[1].evaluate(()=>globalThis.BilikaraRemoteTransport?.disconnect()).catch(()=>{});
      if(pages[0]&&await pages[0].locator('#internet-remote-stop').isVisible().catch(()=>false))await pages[0].locator('#internet-remote-stop').click().catch(()=>{});
      await delay(300);
      for(const browser of browsers.reverse())await browser.close();
    }
  }
}
