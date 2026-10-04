// Concurrent, read-only Remote SSE connection pressure. No login, mutations or
// interpreter subprocesses; every connection belongs to this bounded run.
import http from 'node:http';
import https from 'node:https';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export function parseOptions(argv) {
  const options = {clients: 20, duration: 15, connectTimeout: 5, reconnectDelay: 1};
  const names = {'--host': 'host', '--port': 'port', '--clients': 'clients', '--duration': 'duration', '--connect-timeout': 'connectTimeout', '--reconnect-delay': 'reconnectDelay'};
  let base;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return {help: true};
    const key = names[arg];
    if (key) {
      if (++index === argv.length) throw new Error(`${arg} requires a value`);
      options[key] = key === 'host' ? argv[index] : Number(argv[index]);
    } else if (arg.startsWith('-') || base !== undefined) throw new Error(`unexpected argument: ${arg}`);
    else base = arg;
  }
  if (base !== undefined && (options.host !== undefined || options.port !== undefined)) throw new Error('use either BASE_URL or --host/--port, not both');
  if (!Number.isSafeInteger(options.clients) || options.clients < 1) throw new Error('--clients must be at least 1');
  if (!Number.isFinite(options.duration) || options.duration <= 0) throw new Error('--duration must be greater than 0');
  if (!Number.isFinite(options.connectTimeout) || options.connectTimeout <= 0) throw new Error('--connect-timeout must be greater than 0');
  if (!Number.isFinite(options.reconnectDelay) || options.reconnectDelay < .25) throw new Error('--reconnect-delay must be at least 0.25 seconds');
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) throw new Error('--port must be between 1 and 65535');
  if (base === undefined) {
    const host = options.host || '127.0.0.1';
    base = `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${options.port || 8080}`;
  }
  if (!base.includes('://')) base = 'http://' + base;
  let url;
  try { url = new URL(base); } catch { throw new Error('BASE_URL must be an http(s) URL or host:port'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error('BASE_URL must be an http(s) URL or host:port');
  if (url.search || url.hash) throw new Error('BASE_URL must not contain a query string or fragment');
  // The previous tool never provisioned credentials or sent URL userinfo.
  url.username = ''; url.password = '';
  return {...options, url};
}

function recordEvent(stats, name, data) {
  stats.events++;
  if (name !== 'state') return;
  stats.state_events++;
  try {
    const payload = JSON.parse(data);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const raw = payload.state_revision || 0;
    if (typeof raw === 'object') return;
    const value = typeof raw === 'string' ? (/^[+-]?\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN) : Math.trunc(Number(raw));
    if (Number.isFinite(value) && value >= 0) { stats.revisionMin = Math.min(stats.revisionMin, value); stats.revisionMax = Math.max(stats.revisionMax, value); }
  } catch { /* Malformed state still counts as an observed state event. */ }
}

async function connection(options, stats, signal) {
  const url = new URL(options.url);
  url.pathname = url.pathname.replace(/\/+$/, '') + '/api/events';
  url.search = new URLSearchParams({client_id: `load-test-${stats.index}`}).toString();
  await new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(url, {signal, agent: false, headers: {
      Accept: 'text/event-stream', 'Cache-Control': 'no-cache', 'User-Agent': 'bilikara-remote-sse-load-test/1',
    }});
    request.setTimeout(options.connectTimeout * 1000, () => request.destroy(new Error('connection timed out')));
    request.on('error', reject);
    request.on('response', response => {
      if (response.statusCode !== 200) { request.destroy(new Error(`HTTP ${response.statusCode} ${response.statusMessage}`)); return; }
      const contentType = response.headers['content-type'] || '';
      if (!contentType.toLowerCase().includes('text/event-stream')) { request.destroy(new Error(`unexpected Content-Type: ${contentType || '<missing>'}`)); return; }
      stats.connected = true; stats.successful_connections++;
      const decoder = new StringDecoder('utf8'); let pending = '', event = 'message', data = [], frameBytes = 0;
      response.on('data', chunk => {
        pending += decoder.write(chunk);
        if (Buffer.byteLength(pending) + frameBytes > 64 * 1024 * 1024) { request.destroy(new Error('SSE frame exceeded 64 MiB')); return; }
        let end;
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end).replace(/\r+$/, ''); pending = pending.slice(end + 1);
          if (!line) {
            if (data.length) recordEvent(stats, event, data.join('\n'));
            event = 'message'; data = []; frameBytes = 0;
          } else if (line.startsWith('event:')) event = line.slice(6).trim() || 'message';
          else if (line.startsWith('data:')) { const value = line.slice(5).trimStart(); data.push(value); frameBytes += Buffer.byteLength(value); }
        }
      });
      response.on('end', resolve); response.on('error', reject);
      response.on('aborted', () => reject(new Error('response interrupted')));
    });
  });
}

export async function runLoad(options) {
  const controller = new AbortController(), started = performance.now();
  const stop = setTimeout(() => controller.abort(), options.duration * 1000);
  const snapshots = Array.from({length: options.clients}, (_, index) => ({index: index + 1, connected: false, successful_connections: 0,
    attempts: 0, reconnects: 0, events: 0, state_events: 0, disconnects: 0, errors: 0, revisionMin: Infinity, revisionMax: -Infinity, last_error: ''}));
  try {
    await Promise.all(snapshots.map(async stats => {
      while (!controller.signal.aborted) {
        if (stats.attempts) {
          try { await delay(options.reconnectDelay * 1000, undefined, {signal: controller.signal}); } catch { return; }
          stats.reconnects++;
        }
        stats.attempts++;
        try { await connection(options, stats, controller.signal); if (!controller.signal.aborted) stats.disconnects++; }
        catch (error) { if (!controller.signal.aborted) { stats.errors++; stats.last_error = error.message.replace(/[\r\n]/g, ' ').slice(0, 1024); } }
      }
    }));
  } finally { clearTimeout(stop); controller.abort(); }
  return {snapshots, runtime: (performance.now() - started) / 1000,
    status: Number(snapshots.some(stats => !stats.connected || stats.errors > 0))};
}

export function summary({snapshots, runtime}) {
  const counts = snapshots.map(stats => stats.events).sort((a, b) => a - b), sum = key => snapshots.reduce((total, stats) => total + stats[key], 0);
  const median = (counts[Math.floor((counts.length - 1) / 2)] + counts[Math.floor(counts.length / 2)]) / 2;
  return snapshots.map(stats => `client ${String(stats.index).padStart(2, '0')}: connected=${stats.connected ? 'True' : 'False'} successful_connections=${stats.successful_connections} attempts=${stats.attempts} reconnects=${stats.reconnects} events=${stats.events} state_events=${stats.state_events} revisions=${stats.revisionMin === Infinity ? '-' : `${stats.revisionMin}..${stats.revisionMax}`} disconnects=${stats.disconnects} errors=${stats.errors}${stats.last_error ? ` last_error=${stats.last_error}` : ''}`)
    .concat(['aggregate:', `  requested clients: ${snapshots.length}`, `  successful clients: ${sum('connected')}`, `  total events: ${sum('events')}`,
      `  total state events: ${sum('state_events')}`, `  disconnects: ${sum('disconnects')}`, `  errors: ${sum('errors')}`, `  reconnects: ${sum('reconnects')}`,
      `  runtime seconds: ${runtime.toFixed(2)}`, `  events/client: min=${counts[0]} median=${median.toFixed(1)} mean=${(sum('events') / counts.length).toFixed(1)} max=${counts.at(-1)}`]).join('\n') + '\n';
}

export async function main(argv) {
  const options = parseOptions(argv);
  if (options.help) { console.log('Usage: node tools/load_test_remote_sse.mjs [BASE_URL | --host HOST --port PORT] [--clients 20] [--duration 15] [--connect-timeout 5] [--reconnect-delay 1]'); return 0; }
  const result = await runLoad(options); process.stdout.write(summary(result)); return result.status;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
