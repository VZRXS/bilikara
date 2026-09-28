import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { verifyReleaseMirror } from "../scripts/verify_release_mirror.mjs";

test("R2 receipt requires matching downloaded assets and metadata, including same-size replacements", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "release-mirror-"));
  try {
    const metadata = path.join(root, "metadata"), assets = path.join(root, "assets"), r2 = path.join(root, "r2");
    for (const directory of [metadata, assets, path.join(r2, "assets"), path.join(r2, "metadata")]) {
      await fs.mkdir(directory, { recursive: true });
    }
    const name = "bilikara-windows-x64.zip", body = Buffer.from("new bundle");
    const asset = { name, size: body.length, digest: `sha256:${createHash("sha256").update(body).digest("hex")}` };
    const release = { tag_name: "v0.8.0-preview.2", draft: false, assets: [asset] };
    await fs.writeFile(path.join(metadata, "current-github.json"), JSON.stringify(release), "utf8");
    for (const file of ["tag.json", "releases.json"]) {
      const text = JSON.stringify(file === "tag.json" ? release : [release]);
      await fs.writeFile(path.join(metadata, file), text, "utf8");
      await fs.writeFile(path.join(r2, "metadata", file), text, "utf8");
    }
    await fs.writeFile(path.join(assets, name), body);
    await fs.writeFile(path.join(r2, "assets", name), body);
    assert.deepEqual((await verifyReleaseMirror(metadata, assets, r2)).assets, [asset]);
    await fs.writeFile(path.join(r2, "assets", name), "old bundle", "utf8");
    await assert.rejects(verifyReleaseMirror(metadata, assets, r2), /Wrong SHA-256/);
    await fs.writeFile(path.join(r2, "assets", name), body);
    await fs.writeFile(path.join(r2, "metadata", "tag.json"), "{}", "utf8");
    await assert.rejects(verifyReleaseMirror(metadata, assets, r2), /Stale R2 metadata/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
