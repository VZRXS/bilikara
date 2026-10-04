// Recording Bash/Cargo evidence only. The actual shared helper is unchanged.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { executableOnPath, root, runNative } from './desktop_construction_support.mjs';
import { ownedDirectory } from './libav_prerequisite_support.mjs';

let directory, source, stub, kit, bash;
const portable = file => file.split(path.sep).join('/');
const args = ['libav-cache', 'snapshot', 'prefix 空格 ; $(touch evaluated)', 'cache \' & $USER 中文\nsecond line', 'backslash \\ "quoted" ${HOME} `touch evaluated`'];
before(() => {
  const gitBash = process.platform === 'win32' && process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Git/bin/bash.exe') : undefined;
  bash = gitBash && existsSync(gitBash) ? gitBash : executableOnPath(process.platform === 'win32' ? 'bash.exe' : 'bash');
  assert.ok(bash, 'Native Bash is required for the explicit libav wrapper contract entry');
  directory = ownedDirectory('libav wrapper');
  source = path.join(directory, 'external FFmpeg source 中文'); mkdirSync(path.join(source, 'ffbuild'), { recursive: true });
  writeFileSync(path.join(source, 'ffbuild/config.log'), 'configure log from the extracted source\n', 'utf8');
  stub = path.join(directory, 'recording tools 中文'); mkdirSync(stub);
  const cargo = path.join(stub, 'cargo');
  writeFileSync(cargo, '#!/usr/bin/env bash\nprintf "%s\\0" "$PWD" "${RUSTUP_TOOLCHAIN-}" "$@"\nprintf "%s\\n" "recorded Cargo diagnostic" >&2\nexit "$CARGO_RECORD_EXIT"\n', 'utf8');
  chmodSync(cargo, 0o755);
  kit = path.join(directory, 'independent source kit 中文 ; $()'); mkdirSync(path.join(kit, 'media-libav'), { recursive: true }); mkdirSync(path.join(kit, 'xtask'));
  for (const name of ['media-libav/xtask.sh', 'rust-toolchain.toml']) copyFileSync(path.join(root, name), path.join(kit, name));
  writeFileSync(path.join(kit, 'xtask/Cargo.toml'), '# independent kit fixture\n', 'utf8');
  assert.deepEqual(readFileSync(path.join(kit, 'media-libav/xtask.sh')), readFileSync(path.join(root, 'media-libav/xtask.sh')), 'source the real helper bytes unchanged');
});
after(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

async function invoke(repo, helper, code = 0, trap = false) {
  const script = `
set -u
repo="$1"; helper="$2"; source_dir="$3"; stub_dir="$4"
shift 4
if [ -d "$repo" ]; then repo="$(cd "$repo" && pwd)"; fi
stub_dir="$(cd "$stub_dir" && pwd)"
export PATH="$stub_dir:$PATH"
source "$helper"
cd "$source_dir" || exit
if [ -n "\${LIBAV_WRAPPER_TRAP_LOG-}" ]; then
  trap 'cat ffbuild/config.log > "$LIBAV_WRAPPER_TRAP_LOG"' EXIT
fi
printf '%s\\0' "$repo" "$PWD"
if bilikara_xtask "$@"; then status=0; else status=$?; fi
printf '%s\\0' "$PWD" "$status"
exit "$status"
`;
  return runNative(bash, ['--noprofile', '--norc', '-c', script, 'libav wrapper test', ...[repo, helper, source, stub].map(portable), ...args],
    { ...process.env, CARGO_RECORD_EXIT: String(code), RUSTUP_TOOLCHAIN: 'explicit-user-override', LIBAV_WRAPPER_TRAP_LOG: trap ? portable(path.join(directory, 'saved config.log')) : '' }, 20_000, source);
}
function assertRecord(result, code) {
  assert.equal(result.status, code, result.stderr);
  const fields = result.stdout.split('\0'); assert.equal(fields.pop(), '');
  const [repo, caller] = fields;
  assert.deepEqual(fields.slice(2), [repo, 'explicit-user-override', 'run', '--manifest-path', `${repo}/xtask/Cargo.toml`, '--locked', '--target', 'host-tuple', '--', ...args, caller, String(code)]);
  assert.equal(result.stderr, 'recorded Cargo diagnostic\n');
  assert.equal(existsSync(path.join(source, 'evaluated')), false, 'shell-looking arguments must not execute');
}

test('external source calls Cargo at checkout root and preserves caller cwd/argument boundaries', async () => {
  assertRecord(await invoke(root, path.join(root, 'media-libav/xtask.sh')), 0);
});
test('independent rebuild kit selects its own copied root without the application', async () => {
  assertRecord(await invoke(kit, path.join(kit, 'media-libav/xtask.sh')), 0);
  for (const name of ['rust-runtime', 'rust', 'bilikara']) assert.equal(existsSync(path.join(kit, name)), false);
});
test('Cargo failure preserves user toolchain override, stderr, status and outer cwd', async () => {
  for (const repo of [root, kit]) assertRecord(await invoke(repo, path.join(repo, 'media-libav/xtask.sh'), 29), 29);
});
test('missing root fails before invoking Cargo and leaves the caller cwd unchanged', async () => {
  const result = await invoke(path.join(directory, 'missing root'), path.join(root, 'media-libav/xtask.sh'));
  assert.notEqual(result.status, 0, result.stderr);
  const fields = result.stdout.split('\0'); assert.equal(fields.length, 5); assert.equal(fields[4], '');
  assert.equal(fields[1], fields[2]); assert.equal(fields[3], String(result.status));
  assert.ok(!result.stderr.includes('recorded Cargo diagnostic'), result.stderr);
});
test('caller EXIT trap reads the source configure log after helper success and failure', async () => {
  for (const code of [0, 29]) {
    assertRecord(await invoke(kit, path.join(kit, 'media-libav/xtask.sh'), code, true), code);
    assert.deepEqual(readFileSync(path.join(directory, 'saved config.log')), readFileSync(path.join(source, 'ffbuild/config.log')));
  }
});
