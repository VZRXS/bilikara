// Packaging only: reproducible Android versions and clear test/release names.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function androidVersion(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)(?:-preview\.(\d+))?$/.exec(tag);
  if (!match) throw new Error("Android tags must be vMAJOR.MINOR.PATCH[-preview.N]");
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  const preview = match[4] === undefined ? 9999 : Number(match[4]);
  if (major > 20 || minor > 99 || patch > 99 || preview > 9999 || (match[4] !== undefined && preview === 9999)) {
    throw new Error("Android version exceeds the supported versionCode range");
  }
  const code = major * 100000000 + minor * 1000000 + patch * 10000 + preview;
  if (code < 1 || code > 2100000000) throw new Error("Invalid Android versionCode");
  return { name: tag.slice(1), code };
}

export function buildMetadata(env) {
  const release = env.GITHUB_REF_TYPE === "tag";
  if (release) {
    const version = androidVersion(env.GITHUB_REF_NAME);
    return { release: true, version, apk: `bilikara-${env.GITHUB_REF_NAME}-android-arm64.apk` };
  }
  const ref = String(env.GITHUB_REF_NAME || "local").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);
  return { release: false, version: androidVersion("v0.8.0-preview.0"), apk: `bilikara-beta-${ref}-android-arm64-debug.apk` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const meta = buildMetadata(process.env);
  if (meta.release) {
    for (const key of ["ANDROID_KEYSTORE_BASE64", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD"]) {
      if (!process.env[key]?.trim()) throw new Error(`Missing ${key}; refusing to publish a test-signed APK`);
    }
    const keystore = path.join(process.env.RUNNER_TEMP, "bilikara-android-release.jks");
    fs.writeFileSync(keystore, Buffer.from(process.env.ANDROID_KEYSTORE_BASE64, "base64"), { mode: 0o600, flag: "wx" });
    fs.appendFileSync(process.env.GITHUB_ENV, `ANDROID_KEYSTORE_PATH=${keystore}\n`);
  }
  fs.appendFileSync(process.env.GITHUB_ENV,
    `BILIKARA_ANDROID_VERSION_NAME=${meta.version.name}\nBILIKARA_ANDROID_VERSION_CODE=${meta.version.code}\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `release=${meta.release}\napk=${meta.apk}\n`);
}
