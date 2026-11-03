import { readSourceText } from './frontend_contract_support.mjs';
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { androidVersion, buildMetadata, prepareBetaSigning, verifyBetaSigner } from "../scripts/android_release.mjs";

test("Android preview/stable versionCodes increase without colliding with prior Alpha", () => {
  const tags = ["v0.8.0-preview.0", "v0.8.0-preview.12", "v0.8.0", "v0.8.1-preview.0", "v0.8.1", "v0.9.0", "v1.0.0"];
  let code = 8000;
  for (const tag of tags) { assert.ok(androidVersion(tag).code > code); code = androidVersion(tag).code; }
  for (const tag of ["main", "v0.8.0/evil", "v0.8.0-preview.9999", "v0.100.0", "v21.0.0", "v0.0.0-preview.0"]) {
    assert.throws(() => androidVersion(tag));
  }
});
test("only tag APKs use the installable release name", () => {
  const debug = buildMetadata({ GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "codex/android-beta" });
  assert.equal(debug.release, false); assert.match(debug.apk, /-debug\.apk$/);
  const release = buildMetadata({ GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v0.8.0-preview.1" });
  assert.equal(release.apk, "bilikara-v0.8.0-preview.1-android-arm64.apk");
});
test("Android SDK bootstrap excludes the unavailable legacy tools package", () => {
  const workflow = readSourceText(new URL("../.github/workflows/mobile.yml", import.meta.url));
  const job = workflow.match(/\n  bundle:\n([\s\S]*?)(?=\n  [\w-]+:|$)/)?.[1];
  assert.ok(job, "Android APK job must exist");
  assert.match(job, /^    needs: test$/m, "APK build must wait for its own Android test matrix");
  const checks = workflow.match(/\n  test:\n([\s\S]*?)(?=\n  [\w-]+:|$)/)?.[1];
  assert.ok(checks);
  assert.doesNotMatch(checks, /^    needs:/m, "Android tests must not wait for desktop tests");
  for (const matrix of [checks, job]) assert.match(matrix, /    strategy:\n      fail-fast: false\n      matrix:/);
  assert.doesNotMatch(job, /^    if:/m, "Independent Android entry must not omit PR builds");
  const setup = workflow.match(/- name: Setup Android SDK\n([\s\S]*?)(?=\n      - name:)/)?.[1];
  assert.ok(setup, "Android SDK setup step must exist");
  assert.match(setup, /uses: android-actions\/setup-android@v4/);
  const packages = setup.match(/^\s+packages:\s*([^\n]+)$/m)?.[1];
  assert.ok(packages, "Override setup-android's legacy tools default explicitly");
  assert.deepEqual(packages.trim().split(/\s+/), ["platform-tools"]);
  assert.match(workflow, /sdkmanager "platforms;android-36" "build-tools;36\.0\.0" "ndk;27\.0\.12077973"/);
});
test("mirror waits for APK and publishes the release index; tag build fails closed without signing", () => {
  const workflow = readSourceText(new URL("../.github/workflows/ci-bundle.yml", import.meta.url));
  assert.match(workflow, /needs: \[desktop, mobile\]/);
  assert.match(workflow, /aws s3 cp release-metadata\/releases.json/);
  const packaging = fs.readFileSync(new URL("../scripts/android_release.mjs", import.meta.url), "utf8");
  for (const secret of ["ANDROID_KEYSTORE_BASE64", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD"]) assert.ok(packaging.includes(secret));
});

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bilikara-android-signing-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function isolatedCli(directory, overrides) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^ANDROID_(?:BETA_|KEYSTORE|KEY_ALIAS|KEY_PASSWORD)/.test(key)) delete env[key];
  Object.assign(env, {
    GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "work/v0.8.0", GITHUB_EVENT_NAME: "workflow_dispatch",
    RUNNER_TEMP: directory, GITHUB_ENV: path.join(directory, "github-env"), GITHUB_OUTPUT: path.join(directory, "github-output"),
  }, overrides);
  return spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/android_release.mjs", import.meta.url))], { env, encoding: "utf8", timeout: 30000 });
}

test("manual beta builds fail closed without a stable signer; PRs use clearly disposable signing", t => {
  const manual = buildMetadata({ GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "dev", GITHUB_EVENT_NAME: "workflow_dispatch" });
  assert.equal(manual.signing, "beta");
  const directory = temporaryDirectory(t);
  const missing = isolatedCli(directory, {});
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Missing ANDROID_BETA_KEYSTORE_BASE64/);
  assert.equal(fs.existsSync(path.join(directory, "github-output")), false);
  const pr = isolatedCli(directory, { GITHUB_EVENT_NAME: "pull_request", ANDROID_BETA_KEYSTORE_BASE64: "must-not-be-read" });
  assert.equal(pr.status, 0, pr.stderr);
  assert.match(fs.readFileSync(path.join(directory, "github-output"), "utf8"), /signing=ephemeral\napk=.*-ephemeral-debug\.apk/);
  assert.doesNotMatch(fs.readFileSync(path.join(directory, "github-env"), "utf8"), /KEYSTORE/);
  assert.equal(fs.existsSync(path.join(directory, "bilikara-android-beta.p12")), false);
});

test("beta key decoding rejects malformed input before creating signing files", t => {
  const directory = temporaryDirectory(t);
  for (const encoded of ["not-base64!", "Zg", "a".repeat(65537)]) {
    assert.throws(() => prepareBetaSigning({ RUNNER_TEMP: directory, ANDROID_BETA_KEYSTORE_BASE64: encoded }), /Invalid Android beta keystore encoding/);
  }
  assert.deepEqual(fs.readdirSync(directory), []);
});

test("tag builds still require the separate release key even when a beta secret is present", t => {
  const directory = temporaryDirectory(t);
  const result = isolatedCli(directory, { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v0.8.0-preview.3", ANDROID_BETA_KEYSTORE_BASE64: "must-not-be-read" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing ANDROID_KEYSTORE_BASE64/);
  assert.equal(fs.existsSync(path.join(directory, "bilikara-android-beta.p12")), false);
});

test("beta upload gate rejects random, missing and multiple actual signer fingerprints", () => {
  const pin = "a".repeat(64);
  const report = `Signer #1 certificate SHA-256 digest: ${pin}\n`;
  verifyBetaSigner(report, pin);
  assert.throws(() => verifyBetaSigner(report, "b".repeat(64)), /refusing to upload/);
  assert.throws(() => verifyBetaSigner("", pin), /refusing to upload/);
  assert.throws(() => verifyBetaSigner(report + report.replace("#1", "#2"), pin), /refusing to upload/);
});

test("a real beta key restores identically in clean runner directories and rejects another key", { timeout: 60000 }, t => {
  const directory = temporaryDirectory(t);
  const executable = process.platform === "win32" ? "keytool.exe" : "keytool";
  const keytool = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", executable) : executable;
  const fixture = path.join(directory, "fixture.p12");
  const run = (command, args) => execFileSync(command, args, { timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
  const generate = file => run(keytool, ["-genkeypair", "-keystore", file, "-storetype", "PKCS12", "-alias", "androiddebugkey", "-storepass", "android", "-keypass", "android", "-dname", "CN=bilikara signing fixture", "-keyalg", "RSA", "-keysize", "2048", "-validity", "30"]);
  generate(fixture);
  const certificate = run(keytool, ["-exportcert", "-keystore", fixture, "-alias", "androiddebugkey", "-storepass", "android"]);
  const pin = createHash("sha256").update(certificate).digest("hex");
  const env = { JAVA_HOME: process.env.JAVA_HOME, ANDROID_BETA_KEYSTORE_BASE64: fs.readFileSync(fixture).toString("base64") };
  for (const name of ["runner-a", "runner-b"]) {
    const runner = path.join(directory, name); fs.mkdirSync(runner);
    const restored = prepareBetaSigning({ ...env, RUNNER_TEMP: runner }, pin);
    assert.deepEqual(fs.readFileSync(restored), fs.readFileSync(fixture));
    if (process.platform !== "win32") assert.equal(fs.statSync(restored).mode & 0o777, 0o600);
    assert.throws(() => prepareBetaSigning({ ...env, RUNNER_TEMP: runner }, pin), /EEXIST/);
  }
  const invalid = path.join(directory, "invalid"); fs.mkdirSync(invalid);
  assert.throws(() => prepareBetaSigning({ ...env, RUNNER_TEMP: invalid }, "0".repeat(64)), /does not match/);
  assert.deepEqual(fs.readdirSync(invalid), []);

  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const aapt = sdk && path.join(sdk, "build-tools/36.0.0/aapt");
  const apksigner = sdk && path.join(sdk, "build-tools/36.0.0/apksigner");
  if (process.platform !== "linux" || !aapt || !fs.existsSync(aapt) || !fs.existsSync(apksigner)) {
    assert.notEqual(process.env.BILIKARA_REQUIRE_ANDROID_SIGNING_TESTS, "1", "Required real Android signing tools are missing");
    t.diagnostic("SKIP real APK signing subcheck: pinned Linux Android SDK 36 tools not configured; keytool checks passed");
    return;
  }
  const manifest = path.join(directory, "AndroidManifest.xml");
  fs.writeFileSync(manifest, '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.bilikara.app.alpha" android:versionCode="8000000"><uses-sdk android:minSdkVersion="24"/><application android:label="Signing fixture"/></manifest>');
  const unsigned = path.join(directory, "unsigned.apk");
  run(aapt, ["package", "-f", "-M", manifest, "-I", path.join(sdk, "platforms/android-36/android.jar"), "-F", unsigned]);
  for (const name of ["runner-a", "runner-b"]) {
    const apk = path.join(directory, `${name}.apk`);
    run(apksigner, ["sign", "--ks", path.join(directory, name, "bilikara-android-beta.p12"), "--ks-pass", "pass:android", "--out", apk, unsigned]);
    verifyBetaSigner(run(apksigner, ["verify", "--verbose", "--print-certs", apk]).toString("utf8"), pin);
  }
  const wrongKey = path.join(directory, "wrong.p12"); generate(wrongKey);
  const wrongApk = path.join(directory, "wrong.apk");
  run(apksigner, ["sign", "--ks", wrongKey, "--ks-pass", "pass:android", "--out", wrongApk, unsigned]);
  assert.throws(() => verifyBetaSigner(run(apksigner, ["verify", "--verbose", "--print-certs", wrongApk]).toString("utf8"), pin), /refusing to upload/);
});

test("Tauri debug suffix discovery reaches the build type rather than a signing configuration", () => {
  const gradle = readSourceText(new URL("../src-tauri/gen/android/app/build.gradle.kts", import.meta.url));
  // Tauri CLI 2.11 locates the first debug DSL declaration before injecting
  // applicationIdSuffix. A signing-config action must not look like that DSL.
  const debug = /(?:\bgetByName\(\s*"debug"\s*\)|\bdebug\b)\s*\{/.exec(gradle);
  assert.ok(debug, "Android debug build type must be discoverable by Tauri");
  assert.ok(debug.index > gradle.indexOf("buildTypes {"), "Tauri must not inject applicationIdSuffix into signingConfigs");
});

test("manual CI wires the pinned beta signer into Gradle and verifies the final APK before upload", () => {
  const workflow = readSourceText(new URL("../.github/workflows/mobile.yml", import.meta.url));
  const beta = workflow.split("\n").find(line => line.includes("ANDROID_BETA_KEYSTORE_BASE64: ${{"));
  assert.match(beta, /github.event_name == 'workflow_dispatch' && !startsWith\(github.ref, 'refs\/tags\/'\) && secrets.ANDROID_BETA_KEYSTORE_BASE64/);
  assert.match(workflow, /apksigner" verify --verbose --print-certs/);
  assert.match(workflow, /node scripts\/android_release.mjs --verify-signature/);
  assert.ok(workflow.indexOf("--verify-signature") < workflow.indexOf("- name: Upload APK test artifact"));
  assert.match(workflow, /rm -f -- "\$RUNNER_TEMP\/bilikara-android-beta.p12"/);
  const gradle = readSourceText(new URL("../src-tauri/gen/android/app/build.gradle.kts", import.meta.url));
  assert.match(gradle, /signingConfigs.named\("debug"\)\s*\{\s*storeFile = file\(betaSigningPath\)\s*storeType = "PKCS12"/);
  assert.match(gradle, /applicationIdSuffix = "\.alpha"/);
});
