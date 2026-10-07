import { parseArgs } from 'node:util';
import { buildPlaylistStressTests } from './native_runtime_artifacts.mjs';
import { runNative } from './desktop_construction_support.mjs';

try {
  const { values } = parseArgs({ options: {
    stress: {type: 'boolean', default: false}, help: {type: 'boolean', default: false},
    seeds: {type: 'string', default: '100'}, steps: {type: 'string', default: '500'},
    'concurrent-sessions': {type: 'string', default: '8'},
  } });
  if (values.help) {
    console.log('Native playlist regressions: [--stress] [--seeds 1–1000] [--steps 500] [--concurrent-sessions 8]');
  } else {
    const counts = {};
    for (const [option, key, maximum] of [
      ['seeds', 'BILIKARA_PLAYLIST_STRESS_SEEDS', 1000], ['steps', 'BILIKARA_PLAYLIST_STRESS_STEPS', Number.MAX_SAFE_INTEGER],
      ['concurrent-sessions', 'BILIKARA_PLAYLIST_STRESS_CONCURRENT', Number.MAX_SAFE_INTEGER],
    ]) {
      const value = Number(values[option]);
      if (!/^[0-9]+$/.test(values[option]) || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw Error(`invalid --${option}`);
      counts[key] = String(value);
    }
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BILIKARA_PLAYLIST_STRESS_')));
    const executable = await buildPlaylistStressTests();
    const result = await runNative(executable, values.stress ? ['--ignored', '--nocapture'] : [],
      {...environment, ...(values.stress ? counts : {})}, 600_000);
    process.stdout.write(result.stdout); process.stderr.write(result.stderr);
    if (result.status !== 0) throw Error(`native playlist tests failed (${result.status})`);
    if (!/test result: ok\. (?:9 passed; 0 failed; 2 ignored|2 passed; 0 failed; 0 ignored)/.test(result.stdout)) throw Error('native playlist tests did not execute their required cases');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
