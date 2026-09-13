(function (root) {
  "use strict";
  const key = "bilikara.ui.language";
  const valid = value => ["zh", "en", "ja"].includes(value);
  function deviceLanguage(languages) {
    for (const locale of languages || []) {
      const language = String(locale || "").toLowerCase().split(/[-_]/)[0];
      if (valid(language)) return language;
    }
    return "en";
  }
  function create({native, storage, languages, fetch}) {
    const stored = () => { try { return storage?.getItem(key); } catch { return null; } };
    const remember = language => { try { storage?.setItem(key, language); } catch { /* native save remains authoritative */ } };
    async function request(body) {
      const response = await fetch("/api/ui-language", body ? {
        method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body),
      } : {cache: "no-store"});
      const payload = await response.json();
      if (!response.ok || !payload.ok || !(payload.data?.language === null || valid(payload.data?.language))) {
        throw new Error("Language preference unavailable");
      }
      return payload.data.language;
    }
    return {
      async load() {
        const previous = stored();
        // Desktop keeps its existing preference/default behavior; device-based
        // first launch is for the Native Android Host, not LAN Remote peers.
        if (!native) return valid(previous) ? previous : "zh";
        let language = await request();
        if (!language) language = await request({language: valid(previous) ? previous : deviceLanguage(languages), initialize_only: true});
        if (!valid(language)) throw new Error("Language initialization failed");
        remember(language);
        return language;
      },
      async save(language) {
        if (!valid(language)) throw new Error("Unsupported language");
        const saved = native ? await request({language}) : language;
        if (!valid(saved)) throw new Error("Language save failed");
        remember(saved);
        return saved;
      },
    };
  }
  if (typeof module === "object" && module.exports) module.exports = {create, deviceLanguage};
  if (root.document) {
    let storage;
    try { storage = root.localStorage; } catch { }
    root.BilikaraHostLanguage = create({
      native: root.document.documentElement?.dataset?.nativeHost === "true",
      storage, languages: root.navigator?.languages || [root.navigator?.language],
      fetch: (...args) => root.fetch(...args),
    });
  }
})(globalThis);
