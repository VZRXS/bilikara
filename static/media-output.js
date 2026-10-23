// Shared Host/local/public Remote component. Rust owns selection and transport.
(() => {
  "use strict";
  const instances = new WeakMap();
  let pending = false;
  let nextHelpId = 0;
  const refresh = () => document.querySelectorAll("[data-media-output]").forEach(root => instances.get(root)?.refresh());
  const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  const selected = data => data?.media_output?.target === "purek";
  function create(root, options) {
    root.classList.add("media-output-card");
    const heading = options.host?'<span class="media-output-heading"></span>':'<p class="media-output-heading panel-tag"></p>';
    root.innerHTML = heading+'<span class="media-output-status" role="status"></span><p class="media-output-note"></p><label class="cache-preview-field media-output-targets"><span>DLNA</span><input type="checkbox" role="switch" class="media-output-toggle" /><span class="cache-preview-switch" aria-hidden="true"><span class="cache-preview-switch-thumb"></span></span></label><button type="button" class="media-output-retry" hidden></button><label class="media-output-mode"><span></span><span class="runtime-settings-select-shell"><select class="runtime-settings-select"><option value="splice"></option><option value="gradual"></option></select></span></label><p class="media-output-error" role="alert" hidden></p>';
    const find = s => root.querySelector(s);
    const nodes = {heading:find(".media-output-heading"),status:find(".media-output-status"),note:find(".media-output-note"),targets:find(".media-output-targets"),toggle:find(".media-output-toggle"),retry:find(".media-output-retry"),mode:find(".media-output-mode"),select:find("select"),error:find(".media-output-error")};
    const header = document.createElement("div"), help = document.createElement("span");
    const helpId = `media-output-help-${++nextHelpId}`;
    header.className = `media-output-header ${options.host?"cache":"remote"}-contextual-info-region`;
    if(!options.host)header.classList.add("remote-setting-header");
    help.className = options.host?"cache-advanced-info":"info-trigger-wrap";
    help.innerHTML = `<button type="button" class="media-output-help ${options.host?"cache-advanced-info-button":"remote-info-button"}" aria-expanded="false" aria-describedby="${helpId}"><span class="contextual-info-glyph" aria-hidden="true">i</span></button><span class="media-output-details ${options.host?"cache-advanced-tooltip":"remote-tooltip-bubble"}" id="${helpId}" role="tooltip"></span>`;
    nodes.help = help.querySelector("button");
    const details = help.querySelector("[role=tooltip]");
    details.append(nodes.note,nodes.error);
    nodes.error.removeAttribute("role");
    const title = document.createElement("div");title.className="media-output-title";
    nodes.experimental = document.createElement("span");nodes.experimental.className="experimental-label";
    nodes.experimental.hidden=root.dataset.mediaOutput==="settings";
    title.append(nodes.heading,help,nodes.experimental,nodes.status);
    root.prepend(header);header.append(title,nodes.retry,nodes.targets);
    options.bindHelp?.(header);
    let current = null, errorKey = "";
    async function act(control, work) {
      if (pending || control.disabled) return;
      pending = true; errorKey = ""; control.setAttribute("aria-busy", "true");
      const disabled = control.disabled; control.disabled = true; refresh(); options.onBusy?.();
      try { await work(); }
      catch (error) { errorKey = error?.outputKey || "mediaOutput.error"; options.onError?.(options.t(errorKey)); }
      finally { pending = false; control.disabled = disabled; control.removeAttribute("aria-busy"); refresh(); options.onBusy?.(); }
    }
    const post = async body => {
      const response = await options.request("/api/player/output", body);
      options.accept?.(response);
    };
    const start = async () => {
      await options.beforeNetwork?.();
      await post({target:"purek",experimental:true});
    };
    nodes.toggle.addEventListener("change", () => {const enabled=nodes.toggle.checked;act(nodes.toggle,()=>enabled?start():post({target:"local"}));});
    nodes.retry.addEventListener("click", () => act(nodes.retry,start));
    nodes.select.addEventListener("change", () => {const mode=nodes.select.value;act(nodes.select, () => post({offset_mode:mode}));});
    function render(data) {
      current = data;
      const output = data?.media_output, network = selected(data), t = options.t;
      root.hidden = !output || (!options.host && !network) || (root.dataset.mediaOutput === "console" && !network);
      if (root.hidden) return;
      const host = options.host && output.can_manage;
      const phase = network || ["unsupported","error","probing","unverified"].includes(output.status) ? output.status : output.authorized ? "authorized" : "local";
      text(nodes.heading, t("mediaOutput.title"));
      text(nodes.experimental,t("purek.experimental"));
      nodes.help.setAttribute("aria-label",t("common.moreInfo"));
      text(nodes.status, t(`mediaOutput.status.${["local","authorized","probing","unverified","ready","unsupported","starting","streaming","paused","pausing","stopping","waiting","error","stopped"].includes(phase)?phase:"stopped"}`));
      text(nodes.note, t(network ? (Number.isFinite(output.measured_adjust_latency_ms)?"mediaOutput.experimentalHintMeasured":"mediaOutput.experimentalHint") : phase==="unverified" ? "purek.output.unverified" : "mediaOutput.chooseHint"));
      nodes.targets.hidden = !host;
      nodes.toggle.checked=network;
      nodes.toggle.setAttribute("aria-label",t("mediaOutput.dlna"));
      nodes.toggle.disabled=pending||output.busy||(!network&&(!output.authorized||!output.available));
      nodes.targets.title=t(nodes.toggle.hasAttribute("aria-busy")?"mediaOutput.working":network?"mediaOutput.local":"mediaOutput.dlna");
      nodes.retry.hidden=!host||!network||!output.last_error;
      text(nodes.retry,t(nodes.retry.hasAttribute("aria-busy")?"mediaOutput.working":"mediaOutput.retry"));
      nodes.retry.disabled=pending||output.busy||!output.authorized||!output.available;
      nodes.mode.hidden = !network || root.dataset.mediaOutput === "console";
      text(nodes.mode.firstElementChild,t("mediaOutput.mode"));
      text(nodes.select.options[0],t("mediaOutput.splice"));text(nodes.select.options[1],t("mediaOutput.gradual"));
      if (!nodes.select.hasAttribute("aria-busy")) nodes.select.value=output.offset_mode||"splice";
      nodes.select.setAttribute("aria-label",t("mediaOutput.mode"));nodes.select.disabled = pending || output.busy;
      const serverError = output.status==="error" || output.status==="unsupported";
      const specific = {purek_output_codec:"mediaOutput.codec",purek_output_foreground_required:"mediaOutput.foreground",purek_output_thermal:"mediaOutput.thermal",purek_output_notification_stop:"mediaOutput.notificationStop",purek_output_no_av_transport:"purek.output.noAvTransport",purek_output_no_video_format:"purek.output.noVideoFormat"}[output.last_error];
      nodes.error.hidden = !errorKey && !serverError;
      text(nodes.error,t(errorKey||specific||"mediaOutput.error"));
      if(errorKey)text(nodes.status,t("mediaOutput.actionFailed"));
      nodes.status.hidden=!errorKey&&options.host&&root.dataset.mediaOutput!=="console"&&["local","authorized"].includes(phase);
    }
    return {render,refresh:()=>render(current)};
  }
  function sync(data, options) {
    for (const root of document.querySelectorAll("[data-media-output]")) {
      let instance=instances.get(root);
      if (!instance) {instance=create(root, options);instances.set(root,instance);}
      instance.render(data);
    }
    for (const node of document.querySelectorAll("[data-media-output-latency]")) {
      const value=data?.media_output?.measured_adjust_latency_ms;
      node.hidden=!selected(data)||!Number.isFinite(value)||value<0;
      const args={seconds:(value/1000).toFixed(1)};
      node.setAttribute("aria-label",node.hidden?"":options.t("mediaOutput.latency",args));
      text(node,node.hidden?"":options.t("mediaOutput.latencyShort",args));
    }
  }
  globalThis.BilikaraMediaOutput=Object.freeze({sync,selected,busy:()=>pending});
})();
