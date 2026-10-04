// Read actual locked Cargo metadata instead of maintaining a TOML parser in Node.
import assert from 'node:assert/strict';
import path from 'node:path';
import { runNative } from './desktop_construction_support.mjs';

export async function cargoDependencies(directory) {
  const manifestPath = path.join(directory, 'Cargo.toml');
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'CARGO_BUILD_TARGET'));
  const result = await runNative('cargo', ['metadata', '--manifest-path', manifestPath, '--locked', '--offline', '--no-deps', '--format-version=1'], environment);
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(result.stdout).packages.find(item => path.resolve(item.manifest_path) === manifestPath);
  assert.ok(manifest, 'actual selected Cargo manifest');
  const document = {dependencies: {}, target: {}};
  for (const dependency of manifest.dependencies.filter(item => item.kind === null)) {
    const table = dependency.target ? (document.target[dependency.target] ??= {dependencies: {}}).dependencies : document.dependencies;
    table[dependency.rename || dependency.name] = {version: dependency.req, path: dependency.path ? path.relative(directory, dependency.path).split(path.sep).join('/') : undefined,
      features: dependency.features, 'default-features': dependency.uses_default_features};
  }
  return {document, manifest};
}
