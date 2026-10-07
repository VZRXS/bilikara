// Real Linux Tauri/WebKit/WM acceptance, on a relocated test-owned product.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { root, executableOnPath, runNative } from './desktop_construction_support.mjs';
import { CapturedProcess } from './macos_smoke_process.mjs';
import { HttpClient, isolatedEnvironment, waitFor } from './native_host_support.mjs';

export async function verifyLauncher(output) {
  assert.equal(process.platform, 'linux', 'this native launcher gate requires Linux X11/WebKit');
  const selected = process.env.BILIKARA_TEST_TAURI_EXE;
  assert.ok(selected && path.isAbsolute(selected) && existsSync(selected), 'declare an existing absolute BILIKARA_TEST_TAURI_EXE from the current native construction');
  const source = path.dirname(selected);
  assert.equal(path.basename(selected), 'bilikara-desktop');
  assert.ok(!existsSync(path.join(source, 'runtime')), 'use a clean generated candidate without installed user runtime data');
  const facts = JSON.parse(readFileSync(path.join(source, '_internal/native-desktop.json')));
  assert.equal(facts.backend, 'rust'); assert.equal(facts.development, false);
  assert.equal(facts.platform, 'linux'); assert.equal(facts.arch, process.arch === 'arm64' ? 'arm64' : 'x64');
  for (const file of ['bilikara-desktop-host', 'bilikara-updater']) assert.ok(existsSync(path.join(source, '_internal', file)), file);
  const tools = Object.fromEntries(['Xvfb', 'openbox', 'scrot', 'xdotool'].map(name => {
    const binary = executableOnPath(name); assert.ok(binary, `required native test prerequisite missing: ${name}`); return [name, binary];
  }));
  const temporary = mkdtempSync(path.join(root, '.tmp/desktop launcher 中文 & '));
  let display, wm, app;
  // Retire our detached native groups before the outer orchestration deadline.
  const deadline = setTimeout(() => {
    for (const owned of [app, wm, display]) if (owned) {
      owned.failure = new Error('native launcher acceptance deadline'); owned.signal('SIGKILL');
    }
  }, 540000);
  const proxy = http.createServer((_request, response) => { response.writeHead(503); response.end('offline fixture'); });
  proxy.on('connect', (_request, socket) => { socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n'); });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    mkdirSync(output, { recursive: true });
    const installed = path.join(temporary, 'Installed product 空 & $name');
    cpSync(source, installed, { recursive: true, dereference: false, verbatimSymlinks: true });
    const executable = path.join(installed, path.basename(selected));
    const images = [path.basename(selected), '_internal/bilikara-desktop-host', '_internal/bilikara-updater', '_internal/vendor/BBDown'].map(file => {
      const original = path.join(source, file), copied = path.join(installed, file);
      assert.deepEqual(readFileSync(copied), readFileSync(original), 'relocation preserves compiled executable bytes');
      return { original, copied, sha256: createHash('sha256').update(readFileSync(original)).digest('hex') };
    });
    writeFileSync(path.join(output, 'process-images.json'), JSON.stringify(images, null, 2));
    const env = isolatedEnvironment(temporary);
    display = new CapturedProcess([tools.Xvfb, '-displayfd', '1', '-screen', '0', '1440x1000x24', '-nolisten', 'tcp'], temporary, env);
    const number = await display.waitForOutput((name, line) => name === 'stdout' && /^\d+\s*$/.test(line) ? line.trim() : null, 10);
    assert.ok(number, 'owned Xvfb must select an available display');
    Object.assign(env, { DISPLAY: `:${number}`, WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS: '1' });
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) env[key] = `http://127.0.0.1:${proxy.address().port}`;
    wm = new CapturedProcess([tools.openbox], temporary, env);
    const legacy = path.join(temporary, 'synthetic legacy 中文'); mkdirSync(path.join(legacy, 'data'), { recursive: true });
    const legacyFile = path.join(legacy, 'data/player_state.json');
    writeFileSync(legacyFile, JSON.stringify({ playback_mode: 'local', player_settings: { volume_percent: 43 } }));
    const legacyBytes = readFileSync(legacyFile), results = [];
    const command = async args => { const result = await runNative(tools.xdotool, args, env, 10000, temporary); assert.equal(result.status, 0, result.stderr); return result.stdout; };
    const importDialog = () => waitFor(async () => {
      assert.equal(app.exited, false, app.output.stderr || 'import tool exited before its dialog');
      const found = await runNative(tools.xdotool, ['search', '--onlyvisible', '--name', 'bilikara.*导入'], env, 10000, temporary);
      assert.ok([0, 1].includes(found.status), found.stderr);
      return found.stdout.trim().split('\n').filter(Boolean).at(-1);
    }, 'actual native import dialog', 30000);
    const acceptDialog = async screenshot => {
      const dialog = await importDialog();
      await command(['windowactivate', '--sync', dialog]);
      if (screenshot) {
        const captured = await runNative(tools.scrot, ['-u', path.join(output, screenshot)], env, 10000, temporary);
        assert.equal(captured.status, 0, captured.stderr);
      }
      await command(['key', 'Return']);
      await waitFor(async () => {
        const old = await runNative(tools.xdotool, ['getwindowname', dialog], env, 10000, temporary);
        return old.status !== 0;
      }, 'accepted dialog must close', 30000);
    };
    for (const name of ['default', 'override', 'import', 'restart', 'first-start', 'first-start-skip', 'first-start-failure', 'first-start-external-failure', 'manual-first-failure']) {
      const home = path.join(temporary, name === 'restart' ? 'import' : name); mkdirSync(home, { recursive: true });
      const log = path.join(output, `${name}-startup.log`); rmSync(log, { force: true });
      const appEnv = { ...isolatedEnvironment(home), ...Object.fromEntries(Object.entries(env).filter(([key]) => /proxy/i.test(key))), DISPLAY: env.DISPLAY,
        WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS: '1', BILIKARA_DESKTOP_STARTUP_LOG: log, BILIKARA_DISABLE_MEDIA_CLI: '1', BILIKARA_BILIBILI_COOKIE: '' };
      const firstImport = name.startsWith('first-start') || name === 'manual-first-failure';
      if (name !== 'default' && !firstImport) appEnv.BILIKARA_NATIVE_DATA_DIR = path.join(home, 'preview');
      if (['import', 'restart'].includes(name)) appEnv.BILIKARA_DESKTOP_RUST_IMPORT_FROM = legacy;
      const firstData = path.join(home, 'share/bilikara/data');
      const firstSource = name === 'first-start-external-failure' ? path.join(installed, 'runtime/data') : firstData;
      if (firstImport) {
        mkdirSync(firstSource, { recursive: true });
        writeFileSync(path.join(firstSource, 'player_state.json'), legacyBytes);
        if (['first-start-failure', 'first-start-external-failure', 'manual-first-failure'].includes(name)) writeFileSync(path.join(firstSource, 'history.json'), '{broken legacy history');
      }
      app = new CapturedProcess(name === 'manual-first-failure' ? [executable, '--import-legacy'] : [executable], temporary, appEnv);
      let child;
      try {
        if (firstImport) {
          const dialog = await importDialog();
          assert.equal(existsSync(path.join(firstData, 'host-state.json')), false, 'no checkpoint before consent');
          assert.doesNotMatch(existsSync(log) ? readFileSync(log, 'utf8') : '', /child_pid=/, 'inspection must not start the Host');
          await command(['windowactivate', '--sync', dialog]);
          if (name === 'first-start-skip') {
            const screenshot = await runNative(tools.scrot, ['-u', path.join(output, 'first-start-path-choice.png')], env, 10000, temporary);
            assert.equal(screenshot.status, 0, screenshot.stderr);
            await command(['key', 'Tab', 'Return']);
            const picker = await waitFor(async () => {
              assert.equal(app.exited, false);
              const found = await runNative(tools.xdotool, ['search', '--onlyvisible', '--name', '选择旧版 runtime'], env, 10000, temporary);
              assert.ok([0, 1].includes(found.status), found.stderr); return found.stdout.trim().split('\n').filter(Boolean).at(-1);
            }, 'choose another path must open the actual native runtime folder picker', 15000);
            assert.equal(existsSync(path.join(firstData, 'host-state.json')), false, 'picker must not initialize data');
            assert.doesNotMatch(existsSync(log) ? readFileSync(log, 'utf8') : '', /child_pid=/);
            await command(['windowactivate', '--sync', picker]); await command(['key', 'Escape']);
          } else await command(['key', 'Return']);
          await waitFor(() => existsSync(path.join(firstData, 'host-state.json')), 'consented conversion must commit', 30000);
          if (name === 'manual-first-failure') {
            const notice = await importDialog();
            assert.match(await command(['getwindowname', notice]), /导入未完成/, 'manual failure must show an error rather than an import completion notice');
          }
          if (name !== 'first-start-skip') await acceptDialog(['first-start-failure', 'first-start-external-failure', 'manual-first-failure'].includes(name) ? `${name}-notice.png` : undefined); // Completion/failure notice precedes normal startup.
          assert.equal(JSON.parse(readFileSync(path.join(firstData, 'host-state.json'))).state.player_settings.volume_percent, name === 'first-start' ? 43 : 100);
          if (name === 'manual-first-failure') {
            assert.equal(await app.waitForExit(30), true, 'failed manual tool must close after its error notice');
            // GTK can finish the windowless dialog event loop normally after
            // its error notice. The real offline CLI rejects failures with a
            // nonzero status in desktop_import.test.mjs; GUI failure is checked
            // above through its distinct native error window and raw backup.
            assert.ok([0, 1].includes(app.process.exitCode), app.output.stderr);
            assert.doesNotMatch(existsSync(log) ? readFileSync(log, 'utf8') : '', /child_pid=/, 'failed manual mode must never start a Host');
            writeFileSync(path.join(output, 'manual-failure-tool-stderr.log'), app.output.stderr);
            assert.equal(await app.terminate(), true);
            app = new CapturedProcess([executable], temporary, appEnv);
          }
          const shot = await runNative(tools.scrot, [path.join(output, 'first-start-converted-webview.png')], env, 10000, temporary);
          assert.equal(shot.status, 0, shot.stderr);
        }
        const text = await waitFor(() => {
          assert.equal(app.exited, false, app.output.stderr || 'desktop exited before readiness');
          const content = existsSync(log) ? readFileSync(log, 'utf8') : '';
          return content.includes('event=window_navigate status=ok') && content;
        }, 'real desktop window navigation deadline', 100000);
        child = Number([...text.matchAll(/child_pid=(\d+)/g)].at(-1)[1]);
        const commandLine = readFileSync(`/proc/${child}/cmdline`).toString().replaceAll('\0', ' ');
        assert.match(commandLine, /bilikara-desktop-host/); assert.doesNotMatch(commandLine, /python/i);
        assert.doesNotMatch(readFileSync(`/proc/${child}/maps`, 'utf8'), /libpython/i);
        if (['import', 'restart'].includes(name)) assert.ok(readFileSync(`/proc/${child}/environ`).toString().split('\0').includes(`BILIKARA_DESKTOP_RUST_IMPORT_FROM=${legacy}`));
        let origin = [...text.matchAll(/address=(http[^ ]+|127\.0\.0\.1:\d+)/g)].at(-1)[1].trim();
        if (!origin.startsWith('http')) origin = `http://${origin}`;
        const client = new HttpClient(origin); assert.equal((await client.request('/api/health')).status, 200);
        const window = await waitFor(async () => {
          const found = await runNative(tools.xdotool, ['search', '--onlyvisible', '--pid', String(app.process.pid)], env, 10000, temporary);
          assert.ok([0, 1].includes(found.status), found.stderr); return found.stdout.trim().split('\n').filter(Boolean).at(-1);
        }, 'actual visible Tauri window', 40000);
        await command(['windowactivate', '--sync', window]);
        // Presentation delay only. Native exit and listener checks use barriers.
        await delay(2000);
        const shot = await runNative(tools.scrot, ['-a', '0,180,1440,820', path.join(output, `${name}-webview.png`)], env, 10000, temporary);
        assert.equal(shot.status, 0, shot.stderr);
        const png = readFileSync(path.join(output, `${name}-webview.png`));
        assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        assert.equal(png.readUInt32BE(16), 1440); assert.equal(png.readUInt32BE(20), 820);
        await command(['key', 'alt+F4']);
        assert.equal(await app.waitForExit(40), true, 'WM close must exit the actual shell');
        assert.equal(app.process.exitCode, 0, app.output.stderr);
        await waitFor(() => !existsSync(`/proc/${child}`), 'actual Host child must be reaped', 40000);
        await assert.rejects(client.request('/api/health'), error => ['ECONNREFUSED', 'ECONNRESET'].includes(error.code), 'native listener must close');
        await waitFor(() => readFileSync(log, 'utf8').includes('stage=backend_exited_gracefully'), 'graceful supervised Host shutdown');
        if (['import', 'restart'].includes(name)) {
          assert.equal(JSON.parse(readFileSync(path.join(home, 'preview/host-state.json'))).state.player_settings.volume_percent, 43);
          assert.deepEqual(readFileSync(legacyFile), legacyBytes);
        }
        if (name === 'first-start') {
          // The separate mode remains usable after ordinary startup. Select a
          // known test-owned legacy root and require a second replacement consent.
          assert.equal(await app.terminate(), true);
          const checkpoint = readFileSync(path.join(firstData, 'host-state.json'));
          writeFileSync(path.join(firstData, 'retained-private-file'), 'complete backup');
          const oldData = path.join(installed, 'runtime/data'); mkdirSync(oldData, { recursive: true });
          const sourceBytes = JSON.stringify({ playback_mode: 'local', player_settings: { volume_percent: 77 } });
          writeFileSync(path.join(oldData, 'player_state.json'), sourceBytes);
          app = new CapturedProcess([executable, '--import-legacy'], temporary, appEnv);
          await acceptDialog();
          const confirmation = await importDialog();
          assert.match(await command(['getwindowname', confirmation]), /备份并导入/);
          assert.deepEqual(readFileSync(path.join(firstData, 'host-state.json')), checkpoint, 'source selection does not replace data');
          await acceptDialog();
          await waitFor(() => existsSync(path.join(firstData, 'host-state.json'))
            && JSON.parse(readFileSync(path.join(firstData, 'host-state.json'))).state.player_settings.volume_percent === 77,
            'explicit replacement must complete', 30000);
          await acceptDialog(); assert.equal(await app.waitForExit(30), true); assert.equal(app.process.exitCode, 0);
          const parent = path.dirname(firstData);
          const backups = readdirSync(parent).filter(n => n.startsWith('.bilikara-import-')).map(n => path.join(parent, n, 'legacy/data'));
          const backup = backups.find(p => existsSync(path.join(p, 'retained-private-file')));
          assert.ok(backup, 'complete native backup retained'); assert.deepEqual(readFileSync(path.join(backup, 'host-state.json')), checkpoint);
          assert.equal(existsSync(oldData), false, 'GUI import moves source data out of the old path after completion');
          const sourceBackup = readdirSync(path.dirname(oldData)).filter(n => n.startsWith('.bilikara-imported-'))
            .map(n => path.join(path.dirname(oldData), n, 'data/player_state.json'));
          assert.ok(sourceBackup.some(p => existsSync(p) && readFileSync(p, 'utf8') === sourceBytes), 'source records remain in a recoverable backup');
          assert.equal(existsSync(`/proc/${child}`), false, 'manual tool must not reopen the Host');
          // The same shipped cmd/command shell mode also discovers another
          // native runtime, copies its bytes and cache, and requests explicit
          // replacement consent rather than attempting legacy conversion.
          assert.equal(await app.terminate(), true);
          const prepared = await runNative(path.join(installed, '_internal/bilikara-desktop-host'), ['--start-without-import', '--data-dir', oldData], appEnv, 30000, temporary);
          assert.equal(prepared.status, 0, prepared.stderr);
          const native = JSON.parse(readFileSync(path.join(oldData, 'host-state.json')));
          native.state.player_settings.volume_percent = 81;
          writeFileSync(path.join(oldData, 'host-state.json'), JSON.stringify(native));
          mkdirSync(path.join(oldData, 'cache'), {recursive: true}); writeFileSync(path.join(oldData, 'cache/retained-native-bytes'), Buffer.from([0, 128, 255]));
          const exactNative = readFileSync(path.join(oldData, 'host-state.json'));
          app = new CapturedProcess([executable, '--import-legacy'], temporary, appEnv);
          await acceptDialog('manual-native-copy-confirmation.png'); await acceptDialog();
          await waitFor(() => existsSync(path.join(firstData, 'host-state.json')) && readFileSync(path.join(firstData, 'host-state.json')).equals(exactNative), 'native GUI copy must preserve checkpoint bytes', 30000);
          await acceptDialog(); assert.equal(await app.waitForExit(30), true); assert.equal(app.process.exitCode, 0);
          assert.deepEqual(readFileSync(path.join(firstData, 'cache/retained-native-bytes')), Buffer.from([0, 128, 255]));
          assert.equal(existsSync(oldData), false, 'native source also moves into backup');
          assert.equal(existsSync(`/proc/${child}`), false, 'native copy tool never starts a Host');
        }
        if (['first-start-skip', 'first-start-failure', 'manual-first-failure'].includes(name)) {
          const backups = readdirSync(path.dirname(firstData)).filter(n => n.startsWith('.bilikara-import-'))
            .map(n => path.join(path.dirname(firstData), n, 'legacy/data'));
          assert.ok(backups.some(p => existsSync(path.join(p, 'player_state.json')) && readFileSync(path.join(p, 'player_state.json')).equals(legacyBytes)));
          if (['first-start-failure', 'manual-first-failure'].includes(name)) assert.ok(backups.some(p => existsSync(path.join(p, 'history.json')) && readFileSync(path.join(p, 'history.json'), 'utf8') === '{broken legacy history'));
          const inspected = await runNative(path.join(installed, '_internal/bilikara-desktop-host'), ['--inspect-first-start'], appEnv, 30000, temporary);
          assert.equal(inspected.status, 0, inspected.stderr); assert.deepEqual(JSON.parse(inspected.stdout).candidates, [], 'failure/decline does not rediscover source on the next launch');
        }
        if (name === 'first-start-external-failure') {
          assert.equal(existsSync(firstSource), false, 'failed external source must leave its discovery path');
          const backups = readdirSync(path.join(path.dirname(firstData), 'legacy-backup'))
            .map(n => path.join(path.dirname(firstData), 'legacy-backup', n, 'data'));
          assert.ok(backups.some(p => readFileSync(path.join(p, 'player_state.json')).equals(legacyBytes)
            && readFileSync(path.join(p, 'history.json'), 'utf8') === '{broken legacy history'));
          const anotherEnv = {...appEnv, ...isolatedEnvironment(path.join(home, 'another home'))};
          const inspected = await runNative(path.join(installed, '_internal/bilikara-desktop-host'),
            ['--inspect-first-start', '--data-dir', path.join(home, 'another fresh installation/data')], anotherEnv, 30000, temporary);
          assert.equal(inspected.status, 0, inspected.stderr);
          assert.deepEqual(JSON.parse(inspected.stdout).candidates, [], 'another fresh installation must not discover the isolated failed source');
        }
        results.push({ backend: name, realTauri: true, ready: true, windowClose: true, childReaped: true, listenerClosed: true });
      } finally {
        writeFileSync(path.join(output, `${name}-stdout.log`), app.output.stdout); writeFileSync(path.join(output, `${name}-stderr.log`), app.output.stderr);
        assert.equal(await app.terminate(5, 5), true, 'owned shell process tree cleanup'); app = null;
        if (child) assert.equal(existsSync(`/proc/${child}`), false, 'no lingering owned Host');
      }
    }
    writeFileSync(path.join(output, 'launcher-summary.json'), JSON.stringify(results, null, 2));
    return results;
  } finally {
    clearTimeout(deadline);
    try { if (app) await app.terminate(); if (wm) assert.equal(await wm.terminate(), true); if (display) assert.equal(await display.terminate(), true); }
    finally { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); rmSync(temporary, { recursive: true, force: true }); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 3, 'usage: desktop_launcher_smoke.mjs EVIDENCE_DIRECTORY');
  await verifyLauncher(path.resolve(process.argv[2]));
  console.log('Native, override, import/restart, first-start consent/picker/skip/failure and later legacy/native-copy Tauri checks passed.');
}
