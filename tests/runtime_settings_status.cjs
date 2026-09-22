"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync("static/app.js", "utf8");
function functionSource(name, next) {
  return source.slice(source.indexOf(`function ${name}(`), source.indexOf(`function ${next}(`));
}
const indicators = {};
const context = {
  state: { language: "zh", data: {} },
  elements: { serviceStatusIndicator: "service" },
  t: key => key,
  formatQualityLabel: x => x, formatCacheChipMeta() {}, formatCacheUsage() {},
  localizedBBDownLoginMessage: x => x,
  syncToolIndicator: (element, state) => { indicators[element] = state; },
  setTextContent() {}, setClassToggle: (el, name, value) => { if (el) el[name] = value; },
  renderBBDownLogin() {}, renderCacheUsageDetail() {}, renderCacheSlider() {},
  renderAdvanceDelaySlider() {}, renderCachePolicyControls() {}, renderUpdatePreviewControl() {},
  syncCachePanelVisibility() {},
};
vm.createContext(context);
vm.runInContext(functionSource("renderCacheSettings", "appUpdateStatus")
  + functionSource("aggregateToolStatusState", "frontendPlaybackMode"), context);
const native = {download_source:"native",native_runtime_ready:true,state:"failed"};
context.renderCacheSettings({...native,login:{logged_in:true}}, {state:"disabled"}, {});
assert.doesNotMatch(fs.readFileSync("static/index.html", "utf8"), /id="bilibili-login-status-indicator"/, "The account badge itself represents login status");
assert.match(fs.readFileSync("static/index.html", "utf8"), /id="bbdown-login-button"/);
assert.equal(indicators.service,"ready", "Unused disabled legacy tool does not break Rust Native");
assert.doesNotMatch(fs.readFileSync("static/index.html", "utf8"), /ffmpeg-status-row|ffmpeg-panel-status-indicator/, "No separate FFmpeg lamp remains in runtime settings");
for (const state of ["idle","starting","waiting","failed"]) {
  context.renderCacheSettings({...native,login:{logged_in:false,state}}, {state:"disabled"}, {});
  assert.equal(indicators.service,"warning", "QR lifetime must not change runtime health");
}
context.renderCacheSettings({...native,native_runtime_ready:false,login:{logged_in:true}}, {state:"disabled"}, {});
assert.equal(indicators.service,"failed", "Unavailable native runtime is an operational error");
context.renderCacheSettings({...native,login:{logged_in:true}}, {state:"failed"}, {});
assert.equal(indicators.service,"failed", "Legacy media failures still affect overall runtime status");
context.renderCacheSettings({download_source:"native",ready:true,login:{logged_in:true}}, {state:"disabled"}, {});
assert.equal(indicators.service,"ready", "Existing native Host readiness DTO stays supported");
assert.equal(context.aggregateToolStatusState({state:"checking"}),"loading");
assert.equal(context.aggregateToolStatusState({state:"error"}),"failed");
vm.runInContext(functionSource("localizedBBDownLoginMessage", "localizedApiMessage"), context);
assert.equal(context.localizedBBDownLoginMessage("请使用哔哩哔哩 App 扫码，或截图后从扫一扫相册中选择"),"service.scanWithBilibiliApp");
console.log("PASS runtime account state, removed FFmpeg lamp and concise QR copy");
