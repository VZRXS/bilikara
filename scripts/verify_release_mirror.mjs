import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

export async function verifyReleaseMirror(metadataDir, assetsDir, downloadedDir) {
  const release = JSON.parse(await fs.readFile(path.join(metadataDir, "current-github.json"), "utf8"));
  assert.equal(release.draft, false, "Release must be published before mirroring");
  assert.ok(release.assets?.length, "Release has no assets");
  for (const name of ["tag.json", "releases.json"]) {
    assert.equal(
      await fs.readFile(path.join(downloadedDir, "metadata", name), "utf8"),
      await fs.readFile(path.join(metadataDir, name), "utf8"),
      `Stale R2 metadata: ${name}`,
    );
  }
  const assets = [];
  for (const asset of release.assets) {
    assert.equal(path.basename(asset.name), asset.name, "Invalid release asset name");
    assert.match(asset.digest, /^sha256:[a-f0-9]{64}$/, "GitHub asset digest is required");
    for (const directory of [assetsDir, path.join(downloadedDir, "assets")]) {
      const file = path.join(directory, asset.name);
      assert.equal((await fs.stat(file)).size, asset.size, `Wrong size: ${asset.name}`);
      assert.equal(await digest(file), asset.digest, `Wrong SHA-256: ${asset.name}`);
    }
    assets.push({ name: asset.name, size: asset.size, digest: asset.digest });
  }
  return { tag: release.tag_name, verifiedAt: new Date().toISOString(), metadata: true, assets };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [metadataDir, assetsDir, downloadedDir] = process.argv.slice(2);
  const receipt = await verifyReleaseMirror(metadataDir, assetsDir, downloadedDir);
  await fs.writeFile(path.join(downloadedDir, "verification.json"), JSON.stringify(receipt, null, 2), "utf8");
  console.log(JSON.stringify(receipt, null, 2));
}
