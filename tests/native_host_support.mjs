// Test transport only. The package gate remains in xtask/native_package.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function isolatedEnvironment(home) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:BILIKARA_|BB_DOWN|ARIA2C_|FFMPEG_|FFPROBE_|PYTHON|CARGO_|RUSTUP_|RUSTFLAGS|NODE_|LD_LIBRARY_PATH|DYLD_)/i.test(key)));
  const empty = path.join(home, 'empty-path'); mkdirSync(empty, { recursive: true });
  Object.assign(environment, { HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, 'local'), XDG_DATA_HOME: path.join(home, 'share'), XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'), PATH: empty, BILIKARA_SHUTDOWN_TOKEN: 'fixture-shutdown-capability' });
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) environment[key] = 'http://127.0.0.1:1';
  environment.NO_PROXY = environment.no_proxy = '127.0.0.1,localhost';
  if (process.env.BILIKARA_TEST_LIBAV_COMPANION) environment.BILIKARA_LIBAV_COMPANION = process.env.BILIKARA_TEST_LIBAV_COMPANION;
  return environment;
}

export class HttpClient {
  constructor(base) { this.base = base; this.cookies = new Map(); }
  async request(route, body, headers = {}, redirects = 0) {
    assert.ok(redirects <= 5, 'fixture redirect bound');
    const url = new URL(route, this.base); assert.equal(url.protocol, 'http:');
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const response = await new Promise((resolve, reject) => {
      const request = http.request(url, { method: bytes ? 'POST' : 'GET', headers: { Origin: this.base, 'Content-Type': 'application/json', Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...(bytes ? { 'Content-Length': bytes.length } : {}), ...headers }, timeout: 15000 }, res => {
        const chunks = []; let size = 0;
        res.on('data', data => { size += data.length; if (size > 64 * 1024 * 1024) res.destroy(new Error('fixture response exceeded bound')); else chunks.push(data); });
        res.on('error', reject); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      request.on('timeout', () => request.destroy(new Error('fixture HTTP deadline'))); request.on('error', reject); request.end(bytes);
    });
    for (const cookie of response.headers['set-cookie'] || []) { const pair = cookie.split(';', 1)[0], split = pair.indexOf('='); this.cookies.set(pair.slice(0, split), pair.slice(split + 1)); }
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) return this.request(response.headers.location, undefined, headers, redirects + 1);
    return response;
  }
  async api(route, body, headers) {
    const response = await this.request(route, body, headers); const data = JSON.parse(response.body);
    if (response.status >= 400) throw Object.assign(new Error(`${route} returned ${response.status}: ${data.code}`), { status: response.status, data });
    return data.data;
  }
}

export async function waitFor(read, description, timeout = 12000) {
  const deadline = performance.now() + timeout;
  do { const result = await read(); if (result) return result; await delay(20); } while (performance.now() < deadline);
  assert.fail(description);
}

export class RunningHost extends HttpClient {
  static async start(executable, home, args, env = isolatedEnvironment(home), alpha = false) {
    const host = new RunningHost('');
    host.alpha = alpha;
    const child = spawn(executable, args, { cwd: home, env, windowsHide: true, detached: process.platform !== 'win32' }); host.process = child;
    let output = '', diagnostics = '', size = 0;
    host.finished = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (status, signal) => resolve({ status, signal })); });
    child.stdout.on('data', data => { size += data.length; if (size < 1024 * 1024) output += data.toString(); else host.kill(); });
    child.stderr.on('data', data => { size += data.length; if (size < 1024 * 1024) diagnostics += data.toString(); else host.kill(); });
    try {
      const ready = await waitFor(() => { if (output.includes('\n')) return JSON.parse(output.split('\n', 1)[0]); if (child.exitCode !== null) assert.fail(diagnostics || 'Host exited before readiness'); }, 'Host readiness deadline', 40000);
      if (alpha) { assert.equal(typeof ready.bootstrap_url, 'string'); host.bootstrapUrl = ready.bootstrap_url; host.base = new URL(host.bootstrapUrl).origin; }
      else { assert.equal(ready.backend, 'rust'); host.base = ready.baseUrl; host.bootstrapUrl = ready.bootstrapUrl; }
      const bootstrap = await host.request(host.bootstrapUrl); assert.equal(bootstrap.status, 200, `bootstrap status ${bootstrap.status}`); return host;
    } catch (error) { host.kill(); await host.finished; throw error; }
  }
  kill() {
    if (!this.process.pid || this.process.exitCode !== null || this.process.signalCode !== null) return;
    if (process.platform === 'win32') {
      const result = spawnSync(path.join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(this.process.pid), '/T', '/F'], { timeout: 10000, windowsHide: true }); if (result.status !== 0) this.process.kill('SIGKILL');
    } else { try { process.kill(-this.process.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
  }
  async close(afterAcknowledgement) {
    let timer;
    try {
      if (this.process.exitCode === null && this.process.signalCode === null) {
        if (this.alpha) this.process.stdin.end('\n');
        else { const result = await this.request('/api/app/shutdown', {}, { 'X-Bilikara-Shutdown-Token': 'fixture-shutdown-capability' }); assert.equal(result.status, 200); }
      }
      if (afterAcknowledgement) await afterAcknowledgement();
      const result = await Promise.race([this.finished, new Promise((_, reject) => { timer = setTimeout(() => { this.kill(); reject(new Error('Host shutdown deadline')); }, 30000); })]);
      assert.deepEqual(result, { status: 0, signal: null });
      await assert.rejects(new HttpClient(this.base).request('/api/health'), error => ['ECONNREFUSED', 'ECONNRESET'].includes(error.code), 'listener must retire');
    } finally { clearTimeout(timer); this.kill(); await this.finished; }
  }
}
