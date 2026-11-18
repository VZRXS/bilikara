/* R1 T8 (45a2e8dc, retained through b49e1ae). Rust owns timing, generations and conclusions. */
(() => {
  "use strict";
  function create(adapter) {
    const triggers = () => document.querySelectorAll("[data-cast-compatibility-test]");
    const labelText = key => adapter.translate(`cast.test.${key}`);
    const snapshot = () => adapter.snapshot()?.cast || {};
    const current = () => snapshot().self_test || {};
    const dialog = document.createElement("dialog");
    dialog.id = "cast-self-test";
    dialog.className = "selection-modal-card cast-self-test";
    dialog.setAttribute("aria-labelledby", "cast-test-title");
    // Static markup only; device text and diagnostic text use textContent.
    dialog.innerHTML = `<header class="selection-modal-head"><h2 id="cast-test-title" data-test-text="title"></h2><button type="button" class="banner-close" data-test-close aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2"/></svg></button></header>
      <p data-test-text="intro"></p><label data-test-device-label><span data-test-text="target"></span><select class="confirm-source" data-test-device></select></label>
      <p data-test-retention hidden></p><p data-test-registration hidden></p><p data-test-room hidden></p><p data-test-status role="status" aria-live="polite" tabindex="-1"></p>
      <form data-test-questions hidden>
        <p data-test-countdown hidden><span data-test-countdown-text aria-hidden="true"></span><span data-test-countdown-live role="status" aria-live="polite" class="cast-test-announcement"></span></p>
        <fieldset data-answer="video"><legend data-test-text="video"></legend></fieldset>
        <fieldset data-answer="audio"><legend data-test-text="audio"></legend></fieldset>
        <fieldset data-answer="synchronized"><legend data-test-text="sync"></legend></fieldset>
        <button type="submit" class="next-button" data-test-submit data-test-text="submit"></button>
      </form>
      <p data-test-result></p><p data-test-platform hidden></p><pre data-test-summary hidden></pre>
      <div data-test-handoff hidden><p data-test-text="handoffHint"></p><div class="cast-actions"><button type="button" class="toolbar-button" data-test-finish data-test-text="finish"></button><button type="button" class="next-button" data-test-continue data-test-text="continue"></button></div></div>
      <footer><button type="button" class="toolbar-button" data-test-cancel data-test-text="cancel"></button><button type="button" class="toolbar-button" data-test-copy data-test-text="copy"></button><button type="button" class="next-button" data-test-start data-test-text="start"></button><button type="button" class="next-button" data-test-save data-test-text="save"></button></footer>`;
    document.body.append(dialog);
    const el = selector => dialog.querySelector(selector);
    const buttons = new Set();
    const draft = {};
    let questionKey = "", reportKey = "", report = null, opener = null;
    let loadingReport = false;
    let countdownTimer = null, countdownBucket = null, lastRunning = false;
    function countdown() {
      const test = current();
      const active = dialog.open && test.running && test.question && Number.isFinite(test.question_deadline_ms);
      el('[data-test-countdown]').hidden = !active;
      if (!active) { clearInterval(countdownTimer); countdownTimer = null; countdownBucket = null; return; }
      const seconds = Math.max(0, Math.ceil((test.question_deadline_ms - Date.now()) / 1000));
      const text = labelText('remaining').replace('{seconds}', String(seconds));
      el('[data-test-countdown-text]').textContent = text;
      const bucket = seconds <= 5 ? (seconds === 0 ? 0 : 1) : Math.ceil(seconds / 15) + 1;
      if (bucket !== countdownBucket) { countdownBucket = bucket; el('[data-test-countdown-live]').textContent = text; }
      if (countdownTimer === null) countdownTimer = setInterval(countdown, 1000);
    }
    function errorText(error) {
      const key = `cast.error.${error.code || 'unknown'}`;
      const text = adapter.translate(key);
      return text === key ? adapter.translate('cast.error.unknown') : text;
    }
    const choices = {
      video: ["normal", "stuttering", "black", "unsupported", "uncertain"],
      audio: ["yes", "no", "uncertain"], synchronized: ["yes", "no", "uncertain"],
    };
    for (const [field, values] of Object.entries(choices)) {
      for (const value of values) {
        const label = document.createElement("label"), input = document.createElement("input"), span = document.createElement("span");
        input.type = "radio"; input.name = `cast-test-${field}`; input.value = value;
        input.addEventListener("change", () => { draft[field] = value; render(); });
        span.dataset.testText = value;
        label.append(input, span); el(`[data-answer="${field}"]`).append(label);
      }
    }
    function selectedPayload() {
      const key = el("[data-test-device]").value;
      return key ? { device_key: key } : {};
    }
    async function action(button, work) {
      if (button.disabled || buttons.has(button)) return;
      const disabled = button.disabled;
      buttons.add(button); button.disabled = true; button.setAttribute("aria-busy", "true"); render();
      try { await work(); }
      catch (error) { adapter.error(errorText(error)); }
      finally { buttons.delete(button); button.disabled = disabled; button.removeAttribute("aria-busy"); render(); }
    }
    async function post(actionName, payload = {}) {
      const value = await adapter.post(`/api/cast/self-test/${actionName}`, { generation: current().generation, ...payload });
      await adapter.refresh(); return value;
    }
    function close() { if (!current().running && !buttons.size) {
      dialog.close(); countdown();
      const target = [opener, document.getElementById('purek-close'), document.getElementById('purek-open')]
        .find(node => node?.getClientRects().length && !node.disabled);
      target?.focus();
    } }
    function open(trigger, deviceKey) {
      if (trigger.disabled || adapter.selfTestAvailable?.() === false) return;
      opener = trigger; render();
      if (!current().running && !buttons.size) el("[data-test-device]").value = deviceKey || snapshot().selected || "";
      dialog.inert = false; dialog.showModal(); countdown();
    }
    el("[data-test-close]").addEventListener("click", close);
    dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
    el("[data-test-start]").addEventListener("click", event => action(event.currentTarget, async () => {
      const payload = selectedPayload();
      // Revoke the ordinary session but keep the prepared Pure K room for S2/S3.
      await adapter.closePhysical(); await adapter.disconnect({ retain_room: true });
      report = null; reportKey = "";
      await post("start", payload);
    }));
    el("[data-test-cancel]").addEventListener("click", event => action(event.currentTarget, () => post("cancel")));
    for (const [name, keep] of [['continue', true], ['finish', false]]) {
      el(`[data-test-${name}]`).addEventListener('click', event => action(event.currentTarget, () => post('handoff', { start_casting: keep })));
    }
    el("[data-test-questions]").addEventListener("submit", event => {
      event.preventDefault();
      const test = current(), cell = test.cell, question_id = test.question_id;
      action(el("[data-test-submit]"), () => post("answer", { cell, question_id, answers: {
        video: draft.video, audio: draft.audio, synchronized: test.ask_sync ? draft.synchronized || "uncertain" : "unanswered",
      } }));
    });
    el("[data-test-copy]").addEventListener("click", event => action(event.currentTarget, async () => {
      const value = report || await adapter.getReport();
      const text = `${value.text}\n\n${JSON.stringify({ diagnostics: value.diagnostics }, null, 2)}`;
      if (adapter.copyReport) await adapter.copyReport(text);
      else await navigator.clipboard.writeText(text);
    }));
    el("[data-test-save]").addEventListener("click", event => action(event.currentTarget, async () => {
      const result = await adapter.saveReport();
      if (result === null) {
        const value = report || await adapter.getReport();
        const url = URL.createObjectURL(new Blob([JSON.stringify({ diagnostics: value.diagnostics, summary: value.text }, null, 2)], { type: "application/json" }));
        const link = document.createElement("a"); link.href = url; link.download = "bilikara-cast-self-test.json";
        link.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    }));
    async function loadReport(generation) {
      loadingReport = true;
      try {
        const value = await adapter.getReport();
        if (current().generation === generation && !current().running) { report = value; reportKey = String(generation); }
      } catch (error) { reportKey = String(generation); adapter.error(errorText(error)); }
      finally { loadingReport = false; render(); }
    }
    function render() {
      const test = current(), running = Boolean(test.running);
      for (const trigger of triggers()) {
        trigger.hidden = adapter.selfTestAvailable?.() === false;
        trigger.textContent = labelText("title");
        trigger.disabled = Boolean(adapter.castBusy?.() || adapter.physicalBusy());
      }
      for (const node of dialog.querySelectorAll("[data-test-text]")) node.textContent = labelText(node.dataset.testText);
      el("[data-test-close]").setAttribute("aria-label", adapter.translate("common.close"));
      el("[data-test-close]").disabled = running || buttons.size > 0;
      const select = el("[data-test-device]");
      if (!running && !buttons.size) {
        const options = [{ device_key: "", label: labelText("discover") }, ...(snapshot().renderers || [])];
        const signature = JSON.stringify(options.map(d => [d.device_key, d.label]));
        if (select.dataset.options !== signature) {
          const old = select.value || snapshot().selected || "";
          select.replaceChildren(...options.map(device => new Option(device.label, device.device_key)));
          select.value = options.some(d => d.device_key === old) ? old : "";
          select.dataset.options = signature;
        }
      }
      select.disabled = running || buttons.size > 0;
      el("[data-test-device-label]").hidden = running;
      el("[data-test-retention]").textContent = labelText(test.preferences_persisted ? "retained" : "thisRun");
      el("[data-test-retention]").hidden = !snapshot().selected;
      el("[data-test-registration]").hidden = !test.registration_attempted;
      el("[data-test-registration]").textContent = labelText(test.registered ? "registered" : "unregistered");
      // The prepared Pure K room was not the selected device; never imply it was tested.
      el("[data-test-room]").hidden = !test.purek_room_unmatched;
      el("[data-test-room]").textContent = test.purek_room_unmatched ? labelText("roomUnmatched") : "";
      el("[data-test-status]").textContent = running ? `${labelText(`stage.${test.stage || "s0"}`)}${test.cell ? ` · ${labelText(`cell.${test.cell}`)}` : ""}` : labelText(test.report_available ? "complete" : "ready");
      const key = `${test.generation}:${test.cell}:${test.question_id}`;
      if (key !== questionKey) {
        questionKey = key;
        for (const field of Object.keys(choices)) delete draft[field];
        for (const input of dialog.querySelectorAll("input[type=radio]")) input.checked = false;
        countdownBucket = null;
      }
      el("[data-test-questions]").hidden = !running || !test.question;
      el('[data-test-handoff]').hidden = !running || !test.handoff_available;
      for (const name of ['continue', 'finish']) el(`[data-test-${name}]`).disabled = buttons.size > 0;
      el('[data-answer="synchronized"]').hidden = !test.ask_sync || !["normal", "stuttering"].includes(draft.video);
      el("[data-test-submit]").disabled = !draft.video || !draft.audio || !test.question;
      el("[data-test-cancel]").hidden = !running;
      el("[data-test-start]").hidden = running;
      el("[data-test-start]").disabled = running || buttons.size > 0;
      el("[data-test-start]").className = test.report_available ? 'toolbar-button' : 'next-button';
      el("[data-test-start]").dataset.testText = test.report_available ? 'retest' : 'start';
      el("[data-test-start]").textContent = labelText(test.report_available ? 'retest' : 'start');
      for (const name of ["copy", "save"]) { el(`[data-test-${name}]`).hidden = !test.report_available; el(`[data-test-${name}]`).disabled = running || loadingReport; }
      for (const button of buttons) { button.disabled = true; if (button.dataset.testText) button.textContent = adapter.translate("purek.working"); }
      if (test.report_available && !running && reportKey !== String(test.generation) && !loadingReport) void loadReport(test.generation);
      const row = report?.diagnostics?.cast_self_test?.conclusion?.decision_row;
      el("[data-test-result]").textContent = report ? labelText(row ? `result.${row}` : "inconclusive") : "";
      const unavailable = report?.diagnostics?.cast_self_test?.cells?.filter(cell => cell.skip_reason === 'platform_unavailable') || [];
      const platformMessages = unavailable.map(cell => `${labelText(`cell.${cell.cell}`)}: ${labelText('platformUnavailable')}`);
      const cast = snapshot();
      if (cast.error_code) platformMessages.push(errorText({code: cast.error_code}));
      if (['cellular_default', 'wifi_unvalidated', 'vpn_active', 'multicast_unavailable', 'battery_restricted'].includes(cast.network_hint)) {
        platformMessages.push(adapter.translate(`cast.network.${cast.network_hint}`));
      }
      el('[data-test-platform]').hidden = !platformMessages.length;
      el('[data-test-platform]').textContent = platformMessages.join(' · ');
      el("[data-test-summary]").hidden = !report;
      el("[data-test-summary]").textContent = report?.text || "";
      if (running && !lastRunning && dialog.open) el('[data-test-status]').focus();
      lastRunning = running;
      countdown();
    }
    render();
    return { render, open, busy: () => buttons.size > 0 };
  }
  globalThis.BilikaraCastSelfTest = { create };
})();
