"use strict";
const assert = require("node:assert/strict");
const {create, deviceLanguage} = require("../static/host-language.js");
for (const [locales, expected] of [
  [["en-US"], "en"], [["en-GB"], "en"], [["ja-JP"], "ja"],
  [["zh-CN"], "zh"], [["zh-Hant-TW"], "zh"], [["ZH_hans_CN"], "zh"],
  [["fr-FR", "ja-JP"], "ja"], [["de-DE"], "en"], [[], "en"],
]) assert.equal(deviceLanguage(locales), expected);
(async () => {
  let durable = null, calls = [], fail = false;
  const make = (languages, previous = null, native = true) => {
    const values = new Map(previous ? [["bilikara.ui.language", previous]] : []);
    return create({native, languages, storage: {getItem: key => values.get(key), setItem: (key, value) => values.set(key, value)},
      fetch: async (url, options) => {
        assert.equal(url, "/api/ui-language");
        calls.push(options);
        if (fail) return {ok: false, json: async () => ({ok: false})};
        if (options?.body) {
          const body = JSON.parse(options.body);
          if (!body.initialize_only || durable === null) durable = body.language;
        }
        return {ok: true, json: async () => ({ok: true, data: {language: durable}})};
      }});
  };
  assert.equal(await make(["ja-JP"]).load(), "ja");
  assert.equal(durable, "ja", "Initial language is saved even without a manual selection");
  calls = [];
  assert.equal(await make(["en-US"]).load(), "ja", "Fresh origin / changed system locale cannot override first launch");
  assert.equal(calls.length, 1, "Existing language causes no startup write");
  assert.equal(await make(["en-US"]).save("zh"), "zh");
  assert.equal(await make(["ja-JP"]).load(), "zh", "Explicit choice survives another origin");
  fail = true;
  await assert.rejects(make(["en-US"]).save("en"));
  assert.equal(durable, "zh", "Failed save keeps previous language");
  await assert.rejects(make(["en-US"]).load());
  fail = false;
  durable = null;
  assert.equal(await make(["en-US"], "ja").load(), "ja", "Preserve an existing local preference during migration");
  calls = [];
  assert.equal(await make(["en-US"], null, false).load(), "zh");
  assert.equal(await make(["en-US"], "ja", false).load(), "ja");
  assert.equal(calls.length, 0, "Desktop does not call Native APIs");
  await assert.rejects(make(["ja-JP"]).save("xx"));
  console.log("PASS device locales, first-launch persistence, changed origins/locales, explicit choice, failed save, desktop isolation");
})().catch(error => { console.error(error); process.exitCode = 1; });
