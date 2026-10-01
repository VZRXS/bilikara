import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createHash } from "node:crypto";

const source = readFileSync(new URL("../static/remote-transport-client.js", import.meta.url), "utf8");
const context = vm.createContext({ URL });
for (const [name, next] of [["itemUrl", "localItem"], ["localItem", "localHistoryItem"], ["localHistoryItem", "localState"], ["catalogId", "publicSearchItem"]]) {
  vm.runInContext(source.slice(source.indexOf(`  function ${name}(`), source.indexOf(`  function ${next}(`)), context);
}

test("the two embedded EJS assets match the pinned upstream release", () => {
  for (const [name, hash] of [
    ["lib", "c55987fe697e5b9ee18830163f7af85327e9bb5c3e674b969d38c8d205eaa577"],
    ["core", "18da6ce0758b416e7ae645084f4f8801f9f9d59d6c477c05eaa0ff94ebd8cc00"],
  ]) {
    const vendored = readFileSync(new URL(`../rust-runtime/vendor/yt-dlp-ejs/yt.solver.${name}.min.js`, import.meta.url), "utf8");
    assert.ok(vendored.endsWith("\n"));
    const upstream = vendored.replace(/\r\n/g, "\n").slice(0, -1);
    assert.equal(createHash("sha256").update(upstream).digest("hex"), hash);
  }
});

test("public Remote sends one source-scoped watch identity and strips playlist parameters", () => {
  assert.equal(context.catalogId("https://www.youtube.com/watch?v=YE7VzlLtp-4&list=RDxyz&radio=1&t=3"), "youtube:YE7VzlLtp-4");
  assert.equal(context.catalogId("https://m.youtube.com/watch?v=YE7VzlLtp-4"), "youtube:YE7VzlLtp-4");
  assert.equal(context.catalogId("BV1ab411c7mD", 2), "BV1ab411c7mD_p2");
  for (const url of ["https://youtu.be/YE7VzlLtp-4", "https://www.youtube.com/playlist?list=RDx", "https://www.youtube.com/shorts/YE7VzlLtp-4", "https://u@www.youtube.com/watch?v=YE7VzlLtp-4", "https://www.youtube.com/watch?v=YE7VzlLtp-4&v=abcdefghijk"]) {
    assert.throws(() => context.catalogId(url));
  }
});

test("public queue and history retain YouTube links without inventing Bilibili IDs", () => {
  const source = { provider: "youtube", video_id: "YE7VzlLtp-4" };
  for (const adapt of [context.localItem, context.localHistoryItem]) {
    const item = adapt({media_source: source, bvid: "", page: 1, cache_status: "ready"});
    assert.equal(item.original_url, "https://www.youtube.com/watch?v=YE7VzlLtp-4");
    assert.equal(item.resolved_url, item.original_url);
    assert.equal(item.bvid, "");
  }
  assert.equal(context.itemUrl({bvid:"BV1ab411c7mD", page:2}), "https://www.bilibili.com/video/BV1ab411c7mD?p=2");
});
