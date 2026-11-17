import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
test('Android cast sample asset matches independent CI pins and source notice', () => {
  const bytes = readFileSync(new URL('../resources/cast-samples/sample-b.ts', import.meta.url));
  const hash = createHash('sha256').update(bytes).digest('hex');
  assert.equal(bytes.length, 12079564);
  assert.equal(hash, '8624fbee0c7f4653e6f1c7c2f7a6de9aca5d2b3a3a729a218d7f740b9417aef3');
  assert.ok(source('resources/cast-samples/SOURCE.md').includes(hash));
  assert.ok(source('rust-runtime/src/native_host/cast_session/self_test/samples.rs').includes(hash));
});
test('Gradle sample hook stages only TS and provenance and can remove old assets', () => {
  const build = source('src-tauri/gen/android/app/build.gradle.kts');
  const gradle = source('src-tauri/gen/android/app/cast-samples.gradle.kts');
  assert.match(build, /apply\(from = "cast-samples.gradle.kts"\)/);
  assert.match(gradle, /gradleProperty\("bilikara.includeCastSamples"\)/);
  assert.match(gradle, /toBooleanStrict\(\) }.orElse\(true\)/);
  assert.match(gradle, /listOf\("sample-b.ts", "SOURCE.md"\)/);
  assert.match(gradle, /dir\("cast-samples"\)/);
  assert.match(gradle, /androidResources.noCompress \+= listOf\("ts", "md"\)/);
  assert.match(gradle, /output.delete\(\)/);
  assert.doesNotMatch(gradle, /sample-b.mp4/);
});
test('Sample JNI bridge is private and isolated from fixed Host UI actions', () => {
  const kotlin = source('src-tauri/gen/android/app/src/main/java/com/bilikara/app/HostCastSamples.kt');
  const rust = source('src-tauri/src/android_samples.rs');
  assert.match(kotlin, /@Keep/);
  assert.match(kotlin, /app.cacheDir, "cast-samples"/);
  assert.match(kotlin, /app.assets.open\("cast-samples\/sample-b.ts"\)/);
  assert.match(rust, /getClassLoader/);
  assert.match(rust, /HostCastSamples/);
  assert.match(rust, /SampleStorageInsufficient/);
  assert.match(rust, /PlatformUnavailable/);
  assert.doesNotMatch(kotlin + rust, /addJavascriptInterface|WEB_MESSAGE_LISTENER/);
  const sample = source('rust-runtime/src/native_host/cast_session/self_test/samples.rs');
  assert.doesNotMatch(sample, /if cfg!\(target_os = "android"\)/);
  for (const file of ['self_test/runner.rs', 'pipeline.rs']) {
    assert.match(source(`rust-runtime/src/native_host/cast_session/${file}`), /samples::load_uniform\(context.clone\(\)\).await/);
  }
});
