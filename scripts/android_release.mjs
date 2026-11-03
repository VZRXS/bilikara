// Packaging only: reproducible Android versions and clear test/release names.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Public certificate pin; the independent beta private key lives in Actions
// Secrets and the maintainer's signing backup, never in the repository/cache.
export const betaCertificateSha256 = "ed35127a2b8791b3ae04a941e42bf1559e091a4aaa453af3af6165e825fb971e";

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
    return { release: true, signing: "release", version, apk: `bilikara-${env.GITHUB_REF_NAME}-android-arm64.apk` };
  }
  const ref = String(env.GITHUB_REF_NAME || "local").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);
  const signing = env.GITHUB_EVENT_NAME === "workflow_dispatch" ? "beta" : "ephemeral";
  const suffix = signing === "beta" ? "debug" : "ephemeral-debug";
  return { release: false, signing, version: androidVersion("v0.8.0-preview.0"), apk: `bilikara-beta-${ref}-android-arm64-${suffix}.apk` };
}

export function prepareBetaSigning(env, expectedCertificate = betaCertificateSha256) {
  const encoded = String(env.ANDROID_BETA_KEYSTORE_BASE64 || "").replace(/\s/g, "");
  if (!encoded) throw new Error("Missing ANDROID_BETA_KEYSTORE_BASE64; refusing a non-upgradeable manual APK");
  if (encoded.length > 65536 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error("Invalid Android beta keystore encoding");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new Error("Invalid Android beta keystore encoding");
  const keystore = path.join(env.RUNNER_TEMP, "bilikara-android-beta.p12");
  fs.writeFileSync(keystore, bytes, { mode: 0o600, flag: "wx" });
  try {
    const executable = process.platform === "win32" ? "keytool.exe" : "keytool";
    const keytool = env.JAVA_HOME ? path.join(env.JAVA_HOME, "bin", executable) : executable;
    const certificate = execFileSync(keytool, ["-exportcert", "-keystore", keystore,
      "-alias", "androiddebugkey", "-storepass", "android"], { timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
    if (createHash("sha256").update(certificate).digest("hex") !== expectedCertificate) {
      throw new Error("Android beta signing certificate does not match the pinned fingerprint");
    }
  } catch {
    fs.unlinkSync(keystore);
    throw new Error("Android beta signing key is invalid or does not match the pinned certificate");
  }
  return keystore;
}

export function verifyBetaSigner(report, expectedCertificate = betaCertificateSha256) {
  const signers = [...report.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([a-fA-F0-9]{64})\r?$/gm)];
  if (signers.length !== 1 || signers[0][1].toLowerCase() !== expectedCertificate) {
    throw new Error("APK beta signer differs from the pinned certificate; refusing to upload");
  }
}

function main() {
  if (process.argv[2] === "--verify-signature") {
    const mode = process.argv[4];
    if (!["beta", "release", "ephemeral"].includes(mode)) throw new Error("Unknown APK signing mode");
    if (mode === "beta") verifyBetaSigner(fs.readFileSync(process.argv[3], "utf8"));
    return;
  }
  const meta = buildMetadata(process.env);
  if (meta.release) {
    for (const key of ["ANDROID_KEYSTORE_BASE64", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD"]) {
      if (!process.env[key]?.trim()) throw new Error(`Missing ${key}; refusing to publish a test-signed APK`);
    }
    const keystore = path.join(process.env.RUNNER_TEMP, "bilikara-android-release.jks");
    fs.writeFileSync(keystore, Buffer.from(process.env.ANDROID_KEYSTORE_BASE64, "base64"), { mode: 0o600, flag: "wx" });
    fs.appendFileSync(process.env.GITHUB_ENV, `ANDROID_KEYSTORE_PATH=${keystore}\n`);
  } else if (meta.signing === "beta") {
    const keystore = prepareBetaSigning(process.env);
    fs.appendFileSync(process.env.GITHUB_ENV, `ANDROID_BETA_KEYSTORE_PATH=${keystore}\n`);
  }
  fs.appendFileSync(process.env.GITHUB_ENV,
    `BILIKARA_ANDROID_VERSION_NAME=${meta.version.name}\nBILIKARA_ANDROID_VERSION_CODE=${meta.version.code}\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `release=${meta.release}\nsigning=${meta.signing}\napk=${meta.apk}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
