import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

assert.equal(process.argv.length, 3, 'Usage: check_macos_bundle_readme.mjs FILE');
const text = readFileSync(process.argv[2], 'utf8');
for (const required of ['bilikara-desktop.app', 'bilikara-backend.app', 'license/', '隐私与安全性', '仍要打开']) {
  assert.ok(text.includes(required), `Missing README content: ${required}`);
}
