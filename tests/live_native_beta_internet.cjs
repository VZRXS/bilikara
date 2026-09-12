"use strict";
// Shared Internet Remote wire protocol against the real native Host, offline.
const assert = require("node:assert/strict");
const {spawn} = require("node:child_process");
const {once} = require("node:events");
const {createInterface} = require("node:readline");
const fs = require("node:fs/promises");
const path = require("node:path");
const {chromium} = require("playwright");
const [exe, directory, video, audio, executablePath] = process.argv.slice(2);
(async () => {
  await fs.mkdir(directory, {recursive:true});
  const server = spawn(exe, [path.resolve(directory), path.resolve("static"), video, audio], {stdio:["pipe","pipe","pipe"]});
  const lines = createInterface({input:server.stdout});
  server.stderr.on("data", () => {});
  let browser;
  try {
    const url = JSON.parse((await once(lines,"line"))[0]).bootstrap_url;
    browser = await chromium.launch({headless:true, executablePath, args:["--autoplay-policy=no-user-gesture-required"]});
    const context = await browser.newContext();
    await context.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    const page = await context.newPage();
    page.on("pageerror", error => console.error("Host UI error:", error.message));
    await page.goto(url);
    await page.waitForFunction(() => state.data?.current_item?.id === "fixture-first");
    await page.waitForFunction(() => state.hostPlaybackSession?.readyCommitted);
    await page.waitForFunction(() => !state.localAdvanceInFlight && document.querySelector("video")?.currentTime > 0.3);
    const post = async (api, data) => {
      const response = await context.request.post(new URL(api,url).href, {data});
      return {status:response.status(), body:await response.json()};
    };
    const peer_id = "beta-fixture-peer", epoch = "abcdefghijklmnopqrstuv";
    assert.equal((await post("/api/internet-remote/peer/open", {peer_id,epoch,profile:"controller"})).status, 200);
    let seq = 0;
    const send = async (kind, body, lane = "control", sequence = ++seq) => post("/api/internet-remote/dispatch", {
      peer_id,lane,message:JSON.stringify({v:1,lane,epoch,seq:sequence,id:"123e4567-e89b-42d3-a456-426614174000",kind,body}),
    });
    const identified = await send("session.set_identity", {name:"Internet singer"});
    assert.equal(identified.status, 200, JSON.stringify(identified.body));
    assert.equal(identified.body.data.accepted, true);
    const stateResponse = await context.request.get(new URL("/api/internet-remote/state",url).href);
    const snapshot = (await stateResponse.json()).data;
    assert.ok(snapshot.current_item);
    assert.equal(snapshot.current_item.id, "fixture-first");
    for (const forbidden of ["artifact_relative_directory", "video_media_url", "cookie", "host_token", "media/artifacts"]) {
      assert.ok(!JSON.stringify(snapshot).includes(forbidden), `Public state leaked ${forbidden}`);
    }
    const health = await send("connection.health", {});
    assert.equal(health.body.data.accepted, true);
    const replay = await send("connection.health", {}, "control", seq);
    assert.notEqual(replay.status, 200, "Replayed command must be rejected");
    // Generation guards must still be present across the new transport adapter.
    const next = await send("playback.next", {playback_generation:snapshot.playback_generation});
    assert.equal(next.status, 200, JSON.stringify(next.body));
    assert.equal(next.body.data.accepted, true);
    await page.waitForFunction(() => state.data.current_item?.id === "fixture-second", null, {timeout:6000}).catch(async error => {
      console.log(await page.evaluate(() => ({command:state.data.player_control_command,
        generation:state.data.playback_generation,sessionGeneration:state.hostPlaybackSession?.playbackGeneration,
        hasSession:!!state.hostPlaybackSession,ready:state.hostPlaybackSession?.readyCommitted,
        applied:state.lastAppliedPlayerControlSeq,mode:state.data.playback_mode})));
      throw error;
    });
    const stale = await send("playback.next", {playback_generation:snapshot.playback_generation});
    assert.equal(stale.body.data.accepted, false, JSON.stringify(stale.body));
    assert.equal((await page.evaluate(() => state.data.current_item.id)), "fixture-second");
    // Empty local library reads only: these must not contact Bilibili or D1.
    const pool = await send("gatcha.pool_config_get", {}, "bulk");
    assert.equal(pool.status, 200, JSON.stringify(pool.body));
    assert.equal(pool.body.data.accepted, true);
    const qr = await post("/api/internet-remote/qr", {url:"https://rtc.kevinx96.icu/remote.html#fixture"});
    assert.equal(qr.status, 200); assert.match(qr.body.data.image, /^data:image\/svg\+xml;base64,/);
    assert.notEqual((await post("/api/internet-remote/qr", {url:"https://evil.test/"})).status,200);
    assert.equal((await post("/api/internet-remote/peer/close", {peer_id})).status,200);
    assert.notEqual((await send("connection.health", {})).status,200);
    // Session archives and update administration are Host-only, even after a
    // LAN client successfully registers its singer name.
    const remoteContext = await browser.newContext();
    await remoteContext.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    const remote = await remoteContext.newPage();
    await remote.goto(await page.evaluate(() => state.data.remote_access.local_url));
    await remote.locator("#remote-identity-input").fill("LAN singer"); await remote.locator("#remote-identity-submit").click();
    await remote.waitForFunction(() => state.remoteIdentity?.registered);
    for (const api of ["/api/played-sessions", "/api/internet-remote/state"]) {
      assert.equal((await remoteContext.request.get(new URL(api,url).href)).status(),403);
    }
    assert.equal((await remoteContext.request.post(new URL("/api/app/update/check",url).href,{data:{}})).status(),403);
    // Room lifecycle uses the unmodified shared frontend, with signaling mocked
    // at the network edge so no online room/token is ever created.
    let roomsCreated=0, roomsClosed=0;
    await context.route("https://rtc.kevinx96.icu/v1/rooms**", async route => {
      const request=route.request();
      if(request.method()==="DELETE") { roomsClosed++; return route.fulfill({json:{ok:true}}); }
      assert.equal(request.postDataJSON().lifetime_hours,12);
      roomsCreated++; const now=Date.now();
      return route.fulfill({json:{room_id:"a".repeat(27),created_at:now,expires_at:now+12*3600000}});
    });
    await context.routeWebSocket("wss://rtc.kevinx96.icu/**", socket => { socket.onMessage(()=>{}); });
    await page.locator("#remote-mini-trigger").click();
    await page.evaluate(() => document.dispatchEvent(new CustomEvent("bilikara:remote-access-menu", {detail:{expanded:true}})));
    await page.locator("#internet-remote-restart").click();
    await page.waitForFunction(() => document.getElementById("internet-remote-qr").naturalWidth > 0);
    assert.equal(roomsCreated,1);
    await page.screenshot({path:path.join(directory,"internet-room.png")});
    await page.locator("#internet-remote-stop").click();
    assert.equal(roomsClosed,1);
    console.log(JSON.stringify({passed:true,protocol:true,replayAndStaleGuards:true,publicProjection:true,hostOnlyAdministration:true,roomCreateQrClose:true}));
  } finally {
    if (browser) await browser.close(); lines.close(); server.stdin.end("stop\n");
    if (server.exitCode === null) await once(server,"exit");
  }
})().catch(error => {console.error(error);process.exitCode=1;});
