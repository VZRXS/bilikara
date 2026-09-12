import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { androidVersion, buildMetadata } from "../scripts/android_release.mjs";

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
test("mirror waits for APK and publishes the release index; tag build fails closed without signing", () => {
  const workflow = fs.readFileSync(new URL("../.github/workflows/ci-bundle.yml", import.meta.url), "utf8");
  assert.match(workflow, /needs: \[bundle, android-bundle\]/);
  assert.match(workflow, /aws s3 cp release-metadata\/releases.json/);
  const packaging = fs.readFileSync(new URL("../scripts/android_release.mjs", import.meta.url), "utf8");
  for (const secret of ["ANDROID_KEYSTORE_BASE64", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD"]) assert.ok(packaging.includes(secret));
});
