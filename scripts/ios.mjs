// iOS development entry. Apple SDK discovery belongs to build tooling, not the
// application Runtime. Never fabricate a team, signer, SDK or signing result.
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function probe(command, args) {
  const result = spawnSync(command, args, {cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024});
  if (result.error || result.status !== 0) throw new Error(`${command} unavailable or failed`);
  return result.stdout.trim();
}

function appleEnvironment() {
  if (process.platform !== 'darwin') throw new Error('iOS builds require macOS with Xcode and the iPhoneOS/iPhoneSimulator SDKs. Rust targets alone are insufficient.');
  return {
    xcode: probe('xcodebuild', ['-version']),
    iphoneos: probe('xcrun', ['--sdk', 'iphoneos', '--show-sdk-path']),
    iphonesimulator: probe('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path']),
  };
}

export function iosInvocation(action, args, apple, inherited = process.env) {
  const env = {...inherited};
  const cargoConfig = [];
  for (const [target, sdk] of [
    ['aarch64-apple-ios', apple.iphoneos],
    ['aarch64-apple-ios-sim', apple.iphonesimulator],
    ['x86_64-apple-ios', apple.iphonesimulator],
  ]) {
    // bindgen parses this value with shell_words, but no shell executes it.
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    const key = `BINDGEN_EXTRA_CLANG_ARGS_${target}`;
    const previous = env[key] ?? env[key.replaceAll('-', '_')] ?? env.BINDGEN_EXTRA_CLANG_ARGS ?? '';
    env[key] = `${previous} -isysroot ${quote(sdk)}`.trim();
    // Tauri forwards Cargo arguments to the Xcode build phase, whereas its
    // saved environment only includes selected prefixes. Keep SDK binding
    // available when Xcode is opened as a separate GUI process, too.
    cargoConfig.push('--config', `env.${JSON.stringify(key)}.value = ${JSON.stringify(env[key])}`,
      '--config', `env.${JSON.stringify(key)}.force = true`);
  }
  const separator = args.indexOf('--');
  const tauriArgs = separator < 0 ? [...args] : args.slice(0, separator);
  const cargoArgs = separator < 0 ? [] : args.slice(separator + 1);
  if (action === 'dev' && !tauriArgs.includes('--no-dev-server')) {
    // The startup credential is available only to packaged local assets.
    // Tauri's built-in LAN development server would change that origin and
    // prevent the independent Host from resolving its embedded resources.
    tauriArgs.push('--no-dev-server');
  }
  if (action !== 'init') {
    if (!cargoArgs.includes('--locked')) cargoArgs.push('--locked');
    tauriArgs.push('--', ...cargoArgs, ...cargoConfig);
  } else if (separator >= 0) {
    throw new Error('ios init does not accept Cargo build arguments');
  }
  return {args: [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'ios', action, ...tauriArgs], env};
}

function main() {
  const [action = 'doctor', ...args] = process.argv.slice(2);
  try {
    if (!['doctor', 'init', 'dev', 'build'].includes(action)) throw new Error('Usage: node scripts/ios.mjs doctor|init|dev|build [Tauri arguments]');
    const apple = appleEnvironment();
    if (action === 'doctor') {
      console.log(JSON.stringify({schema_version: 1, platform: process.platform, node: process.version,
        rust: probe('rustc', ['--version']), targets: probe('rustup', ['target', 'list', '--installed']).split('\n'),
        xcode: apple.xcode, sdks_available: ['iphoneos', 'iphonesimulator'],
        signing: 'not_checked', device: 'not_checked', playback: 'unverified'}, null, 2));
    } else {
      const invocation = iosInvocation(action, args, apple);
      const child = spawn(process.execPath, invocation.args,
        {cwd: root, env: invocation.env, stdio: 'inherit'});
      child.once('error', () => { console.error('Tauri iOS CLI could not start; run npm ci first.'); process.exitCode = 1; });
      child.once('exit', code => { process.exitCode = code ?? 1; });
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
