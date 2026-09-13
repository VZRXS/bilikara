"use strict";
// Real Rust Host startup/checkpoint/logout, across three separate processes.
// Uses ONLY a synthetic credential in a new test directory; never contacts Bili.
// node tests/live_native_login_persistence.js EXE NEW_PRIVATE_DIR
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const {spawn} = require("node:child_process");
const {once} = require("node:events");
const {createInterface} = require("node:readline");
const [exe, directory] = process.argv.slice(2);

function request(url, cookie="", body) {
  assert.equal(new URL(url).hostname,"127.0.0.1","Acceptance test must remain offline");
  return new Promise((resolve,reject)=>{
    const req=http.request(url,{method:body===undefined?"GET":"POST",headers:{
      cookie,origin:new URL(url).origin,"content-type":"application/json","x-bilikara-client":"login-fixture"}},res=>{
      let text="";res.setEncoding("utf8");res.on("data",chunk=>{text+=chunk;});
      res.on("end",()=>resolve({status:res.statusCode,headers:res.headers,text}));
    });
    req.setTimeout(10000,()=>req.destroy(Error("Local Host request timed out")));
    req.on("error",reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
}

async function withHost(check) {
  const server=spawn(exe,[path.resolve(directory),path.resolve("static")],{stdio:["pipe","pipe","pipe"]});
  server.stderr.on("data",()=>{});
  const lines=createInterface({input:server.stdout});
  let timeout;
  try {
    const line=await Promise.race([once(lines,"line").then(v=>v[0]),
      once(server,"exit").then(()=>{throw Error("Host exited before bootstrap");}),
      new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error("Host bootstrap timeout")),10000);})]);
    clearTimeout(timeout);
    const url=JSON.parse(line).bootstrap_url;
    const entry=await request(url);
    assert.equal(entry.status,200);
    const cookie=entry.headers["set-cookie"][0].split(";")[0];
    const origin=new URL(url).origin;
    const api=async(route,body)=>{
      const response=await request(origin+route,cookie,body);
      assert.equal(response.status,200,`Local request failed: ${route}`);
      return JSON.parse(response.text).data;
    };
    await check(api,origin);
  } finally {
    clearTimeout(timeout);lines.close();server.stdin.end("stop\n");
    if(server.exitCode===null)await once(server,"exit");
  }
}

(async()=>{
  // Fail if a supplied directory already exists; never touch a real profile.
  await fs.mkdir(path.dirname(path.resolve(directory)),{recursive:true});
  await fs.mkdir(directory);
  // This fixture deliberately opts out of seeded sources: dummy login must never
  // cause live network requests. Source seeding has its own startup regression.
  await fs.writeFile(path.join(directory,"gatcha_uids.json"),JSON.stringify({schema_version:2,uids:[],profiles:{}}));
  await fs.writeFile(path.join(directory,"native-library-defaults.json"),JSON.stringify({schema_version:1}));
  const checkpoint=path.join(directory,"bilibili-login.json");
  const dummyCookie="SESSDATA=alpha-synthetic-session; bili_jct=alpha-synthetic-csrf";
  await fs.writeFile(checkpoint,JSON.stringify({schema_version:1,cookie:dummyCookie}));
  const obsolete=`i-${"a".repeat(32)}-0000000000000001/a-${"a".repeat(32)}-0000000000000001`;
  const oldArtifact=path.join(directory,"media/.staging",obsolete);
  await fs.mkdir(oldArtifact,{recursive:true});
  await fs.writeFile(path.join(oldArtifact,"partial.m4a"),"incomplete fixture");
  const saved=await fs.readFile(checkpoint,"utf8");
  for(let index=0;index<2;index++) {
    await withHost(async(api,origin)=>{
      const snapshot=await api("/api/state");
      assert.equal(snapshot.bbdown.login.logged_in,true);
      assert.equal(await fs.readFile(checkpoint,"utf8"),saved);
      await assert.rejects(fs.stat(oldArtifact),{code:"ENOENT"});
      const deadline=Date.now()+5000;
      while ((await api("/api/state")).gatcha.background_busy && Date.now()<deadline) {
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      const diagnostic=await api("/api/diagnostics/markdown",{});
      const runtime=JSON.parse(diagnostic.markdown.split("## Native runtime (sanitized)")[1].split("```json")[1].split("```")[0]);
      const refresh=runtime.diagnostics.library_refresh;
      assert.equal(refresh.filter(event=>event.trigger==="credential_restore" && event.event==="started").length,1,"One automatic refresh per restored Host process");
      assert.ok(refresh.some(event=>event.event==="success"),"Empty configured library refresh completes without network");
      for(const text of [JSON.stringify(snapshot),diagnostic.markdown]) {
        assert.ok(!text.includes("alpha-synthetic-session") && !text.includes("alpha-synthetic-csrf"));
      }
      const entry=await request(snapshot.remote_access.local_url);
      assert.equal(entry.status,200);
      const remoteCookie=entry.headers["set-cookie"][0].split(";")[0];
      const remote=await request(origin+"/api/state",remoteCookie);
      const remoteState=JSON.parse(remote.text).data;
      assert.equal(remoteState.bbdown.login,undefined);
      assert.ok(!remote.text.includes("alpha-synthetic-session"));
      assert.equal((await request(origin+"/api/bbdown/logout",remoteCookie,{})).status,403);
      assert.equal(await fs.readFile(checkpoint,"utf8"),saved,"Remote cannot clear Host login");
      if(index===1) {
        await api("/api/bbdown/logout",{});
        assert.equal(JSON.parse(await fs.readFile(checkpoint,"utf8")).cookie,"");
      }
    });
  }
  await withHost(async api=>{
    assert.equal((await api("/api/state")).bbdown.login.logged_in,false,"Explicit logout persists across restart");
    const diagnostic=await api("/api/diagnostics/markdown",{});
    const runtime=JSON.parse(diagnostic.markdown.split("## Native runtime (sanitized)")[1].split("```json")[1].split("```")[0]);
    assert.deepEqual(runtime.diagnostics.library_refresh,[],"Signed-out startup does not refresh");
  });
  console.log("PASS three fresh Host processes: login retention, cache cleanup isolation, Remote/diagnostic privacy, durable logout; no Bilibili requests");
})().catch(error=>{console.error(error);process.exitCode=1;});
