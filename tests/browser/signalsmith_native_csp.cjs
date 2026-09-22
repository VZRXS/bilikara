"use strict";
// Real native Host headers and bundled worklet; no media/state/network mocks.
// node tests/browser/signalsmith_native_csp.cjs PRIVATE_BOOTSTRAP_JSON OUTPUT_JSON
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const {chromium} = require("playwright");

(async () => {
  const [bootstrapFile, output] = process.argv.slice(2);
  const bootstrap = JSON.parse(await fs.readFile(bootstrapFile, "utf8"));
  const browser = await chromium.launch({headless: true, chromiumSandbox: true,
    ...(process.env.BILIKARA_BROWSER_EXECUTABLE ? {executablePath: process.env.BILIKARA_BROWSER_EXECUTABLE} : {})});
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(bootstrap.bootstrapUrl || bootstrap.bootstrap_url);
    await page.waitForFunction(() => document.documentElement.dataset.nativeHost === "true");
    const result = await page.evaluate(async () => {
      const audio = new AudioContext();
      let node;
      try {
        const url = new URL("/vendor/signalsmith-stretch/SignalsmithStretch.js", location.href).href;
        const {default: factory} = await import(url);
        factory.moduleUrl = url;
        await audio.audioWorklet.addModule(url);
        node = await factory(audio, {numberOfInputs:1, numberOfOutputs:1, channelCount:2});
        await node.configure({preset:"default"});
        const latency = await node.latency();
        let javascriptEvalBlocked = false;
        try { new Function("return 1")(); } catch (error) { javascriptEvalBlocked = error.name === "EvalError"; }
        return {latency, javascriptEvalBlocked, secureContext:isSecureContext};
      } finally { node?.destroy(); await audio.close(); }
    });
    assert.ok(result.latency > 0 && result.latency <= 1, "Bundled WASM configured in the actual AudioWorklet");
    assert.equal(result.javascriptEvalBlocked, true, "JavaScript string evaluation stays blocked");
    assert.equal(result.secureContext, true);
    await fs.writeFile(output, JSON.stringify({passed:true, ...result}, null, 2));
    console.log(JSON.stringify({passed:true, ...result}));
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
