import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { root } from './desktop_construction_support.mjs';
import { buildNativeHost } from './native_runtime_artifacts.mjs';
import { HttpClient, RunningHost, isolatedEnvironment, waitFor } from './native_host_support.mjs';
import { videoFixture } from './video_service_fixture.mjs';
import { localCertificate } from './local_tls_certificate.mjs';

export const transportVideos = ['BV1xx411c7mD', 'BV1z84y1p7oS', 'BV1tPC2BEEjq', 'BV1uq4y1a7Zo'];
export class TransportFixture {
  static async start(executable) {
    const fixture = new TransportFixture();
    fixture.home = mkdtempSync(path.join(tmpdir(), 'native transport 中文 $() & '));
    const data = path.join(fixture.home, 'data'); mkdirSync(data);
    writeFileSync(path.join(data, '.bilikara-desktop-rust-preview'), 'desktop-rust-preview-v1\n');
    for (const [name, value] of Object.entries({
      'native-library-defaults.json': {schema_version: 1}, 'gatcha_uids.json': {schema_version: 2, uids: [], profiles: {}},
      'gatcha_cache.json': {schema_version: 3, uids: {}, profiles: {}},
    })) writeFileSync(path.join(data, name), JSON.stringify(value));
    fixture.gates = new Map(); fixture.sequences = {control: 0, bulk: 0}; fixture.epoch = 'abcdefghijklmnopqrstuv';
    try {
    const certs = await localCertificate(path.join(fixture.home,'certs'),['api.bilibili.com','passport.bilibili.com','account.bilibili.com','www.bilibili.com']);
    fixture.provider = await videoFixture(async raw => {
      const url = new URL(raw, 'https://api.bilibili.com');
      if (url.pathname === '/x/passport-login/web/qrcode/generate') return {code:0,data:{url:'https://account.bilibili.com/scan?token=synthetic',qrcode_key:'synthetic-key'}};
      if (url.pathname === '/x/passport-login/web/qrcode/poll') return {fixtureResponse:{data:{code:0,data:{code:0}},headers:{'Set-Cookie':['SESSDATA=transport-synthetic; Domain=.bilibili.com; Path=/; Secure; HttpOnly','bili_jct=transport-synthetic-csrf; Domain=.bilibili.com; Path=/; Secure','b_nut=transport-synthetic-nut; Domain=.bilibili.com; Path=/; Secure']}}};
      if (url.pathname.endsWith('/nav')) return {code: 0, data: {wbi_img: {img_url: `https://example.invalid/${'a'.repeat(32)}.png`, sub_url: `https://example.invalid/${'b'.repeat(32)}.png`}}};
      if (url.pathname.endsWith('/view')) {
        const bvid = url.searchParams.get('bvid'); assert.ok(transportVideos.includes(bvid));
        await fixture.hold('metadata');
        return {code: 0, data: {aid: 100 + transportVideos.indexOf(bvid), bvid, title: bvid, owner: {mid: 42, name: 'Fixture'}, pages: [{page: 1, cid: 200 + transportVideos.indexOf(bvid), duration: 90, part: 'on vocal'}]}};
      }
      if (['/api/catalog/search', '/api/search', '/search'].includes(url.pathname)) {
        await fixture.hold('search');
        return transportVideos.map(bvid => ({bvid, title: bvid, url: `https://www.bilibili.com/video/${bvid}`}));
      }
      return {fixtureResponse: {status: 503, data: {error: 'restricted local test provider'}}};
    }, certs, async (request, body) => {
      if (request.url === '/__fixture/hold-search') { fixture.gate('search'); return {data: {ok: true}}; }
      if (request.url === '/__fixture/search-entered') return {data: {entered: fixture.gates.get('search')?.entered || false}};
      if (request.url === '/__fixture/release-search') {fixture.gates.get('search')?.release(); return {data: {ok: true}};}
      // Accepted native additions are sent only to this non-forwarding fixture.
      assert.equal(request.url, '/batch-add'); assert.ok(Array.isArray(body.records));
      assert.equal(request.headers.cookie, undefined); assert.equal(request.headers.authorization, undefined);
      return {data: {success: true, added: body.records.length}};
    });
      fixture.host = await RunningHost.start(executable || await buildNativeHost(), fixture.home,
        ['--headless', '--port', '0', '--data-dir', data, '--static-dir', path.join(root, 'static')],
        {...isolatedEnvironment(fixture.home), ...fixture.provider.environment, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', BILIKARA_CF_API_URL: fixture.provider.base, BILIKARA_CATALOG_SHEETS_URL: ''});
      await fixture.host.api('/api/session-users/add', {name: 'Fixture ID'});
      for (const bvid of transportVideos.slice(0,3)) await fixture.add(bvid);
      await fixture.open(); await fixture.remote('session.set_identity', {name: 'Internet ID'});
      fixture.remoteClient = new HttpClient(fixture.host.base); await fixture.remoteClient.request('/remote');
      await fixture.remoteClient.api('/api/remote-identity/register', {name: 'LAN ID'});
      return fixture;
    } catch (error) { await fixture.close(); throw error; }
  }
  async open() { return this.host.api('/api/internet-remote/peer/open', {peer_id: 'fixture-peer', epoch: this.epoch, profile: 'controller'}); }
  async remote(kind, body, lane = 'control', epoch = this.epoch) {
    const response = await this.host.request('/api/internet-remote/dispatch', {peer_id: 'fixture-peer', lane,
      message: JSON.stringify({v: 1, lane, epoch, seq: ++this.sequences[lane], id: randomUUID(), kind, body})});
    return {...response, json: JSON.parse(response.body)};
  }
  async add(bvid, fields = {}) { return this.host.api('/api/playlist/add', {url: `https://www.bilibili.com/video/${bvid}`, requester_name: 'Fixture ID', ...fields}); }
  async state() { return this.host.api('/api/state'); }
  async target() { const state = await this.state(); return {item_id: state.current_item.id, playback_generation: state.playback_generation}; }
  async drain() {
    const result = [];
    for (let count=0; count<20; count++) {
      const head = (await this.state()).player_control_command;
      if (!head) return result;
      result.push(head); await this.host.api('/api/player/control-ack', {seq: head.seq});
    }
    assert.fail('ACK failed to advance bounded control queue');
  }
  gate(name, requests = Infinity) {
    assert.equal(this.gates.has(name), false); let release;
    const value = {entered: false, requests, promise: new Promise(resolve => {release = resolve;}), release: () => {this.gates.delete(name); release();}};
    this.gates.set(name, value); return value;
  }
  async hold(name) { const gate = this.gates.get(name); if (gate && gate.requests > 0) {gate.requests--; gate.entered = true; await gate.promise;} }
  async wait(gate) { await waitFor(() => gate.entered, 'actual upstream request did not reach gate', 8000); }
  async close() { for (const gate of this.gates?.values() || []) gate.release(); if (this.host) await this.host.close(); if (this.provider) await this.provider.close(); if (this.home) rmSync(this.home,{recursive:true,force:true}); }
}
