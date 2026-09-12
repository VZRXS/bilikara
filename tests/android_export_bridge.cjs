"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const messages = [], observations = [];
const bridge = {postMessage: value => messages.push(JSON.parse(value))};
const context = vm.createContext({document: {documentElement: {dataset: {nativeHost: "true"}}},
  BilikaraHostExport: bridge, BilikaraExportDownload: {recordExportDiagnostic: entry => observations.push(entry)}});
vm.runInContext(fs.readFileSync("static/android-export.js", "utf8"), context);
(async () => {
  const save = context.BilikaraAndroidExport.saveHistory;
  assert.equal(context.document.documentElement.dataset.nativeExportReady, "true");
  for (const [status, expected] of [["cancelled", false], ["saved", true]]) {
    const task = save("csv", "played", 200);
    const count = messages.length;
    await assert.rejects(save("csv", "played", 200), /尚未完成/);
    assert.equal(messages.length, count, "Duplicate export never opens a second picker");
    bridge.onmessage({data: JSON.stringify({id: "stale", status: "saved"})});
    bridge.onmessage({data: JSON.stringify({id: messages.at(-1).id, status})});
    assert.equal(await task, expected);
  }
  const failure = save("image", "history", 50);
  bridge.onmessage({data: JSON.stringify({id: messages.at(-1).id, status: "failed", errorMessage: "Save failed"})});
  await assert.rejects(failure, /Save failed/);
  await assert.rejects(save("csv", "../secret", 50), /无效/);
  await assert.rejects(save("image", "played", 100000), /无效/);
  bridge.postMessage = () => { throw Error("Bridge disconnected"); };
  await assert.rejects(save("csv", "played", 50), /disconnected/);
  await assert.rejects(save("csv", "played", 50), /disconnected/, "Submission error releases the guard");
  assert.equal(observations.length, 3);
  assert.equal(JSON.stringify(messages).includes("cookie"), false);
  console.log("PASS Android export bridge: save, cancel, failure, stale replies, duplicate guard, validation, retry");
})().catch(error => { console.error(error); process.exitCode = 1; });
