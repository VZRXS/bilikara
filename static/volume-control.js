(() => {
  "use strict";

  const bounded = (value) => Math.max(0, Math.min(500, Math.round(Number(value) || 0)));
  const toPosition = (percent) => Math.min(100, bounded(percent));
  const toPercent = toPosition;
  const songResetHandlers = new WeakMap();

  function resetForSong(slider, percent) {
    if (slider) songResetHandlers.get(slider)?.(bounded(percent));
  }

  function render(slider, value, percent) {
    if (!slider || !value) return;
    const current = bounded(percent);
    slider.value = String(toPosition(current));
    slider.style.setProperty("--range-fill-percent", `${toPosition(current)}%`);
    slider.setAttribute("aria-valuenow", String(toPosition(current)));
    slider.setAttribute("aria-valuetext", `${current}%`);
    slider.closest(".volume-control")?.classList.toggle("is-boosted", current > 100);
    value.textContent = `${current}%`;
  }

  function bind({ slider, value, t, getValue, onInput, onCommit }) {
    if (!slider || !value) return;
    const control = slider.parentElement;
    control.classList.add("volume-control");
    const wrap = document.createElement("div");
    wrap.className = "volume-range-wrap";
    slider.before(wrap);
    wrap.append(slider);
    slider.min = "0";
    slider.max = "100";
    slider.step = "1";
    slider.setAttribute("aria-valuemin", "0");
    slider.setAttribute("aria-valuemax", "100");
    slider.setAttribute("data-i18n-aria-label", "player.volumeTag");
    value.classList.add("volume-value-button");
    value.setAttribute("aria-haspopup", "dialog");
    value.setAttribute("aria-expanded", "false");
    value.setAttribute("data-i18n-title", "player.volumeAdjust");
    value.setAttribute("data-i18n-aria-label", "player.volumeAdjust");

    function change(percent) {
      render(slider, value, percent);
      onInput(percent);
    }
    slider.addEventListener("input", () => change(toPercent(slider.value)));
    // Reaching 100 during a drag cannot arm boost. A new drag must start
    // on the end thumb while the existing setting is exactly 100%.
    let gesture = null;
    function beginGesture(x, y) {
      const box = slider.getBoundingClientRect();
      gesture = bounded(getValue()) === 100 && x >= box.right - 24
        ? { x, y, ready: false } : null;
    }
    function moveGesture(x, y) {
      if (!gesture) return;
      const dx = x - gesture.x;
      const dy = Math.abs(y - gesture.y);
      if (dx < -8 || dy > 16) { gesture = null; return; }
      gesture.ready = dx >= 16 && dx > dy * 1.5;
      // Commit the outward gesture while it is still inside this WebView.
      // On a second display the release may land in the output window, where
      // this page cannot receive mouseup/touchend.
      if (gesture.ready) endGesture();
    }
    function endGesture() {
      const open = gesture?.ready;
      gesture = null;
      if (open) openDialog();
    }
    slider.addEventListener("pointerdown", (event) => {
      if (event.isPrimary !== false && event.button === 0) beginGesture(event.clientX, event.clientY);
    });
    window.addEventListener("pointermove", (event) => moveGesture(event.clientX, event.clientY), true);
    window.addEventListener("pointerup", endGesture);
    window.addEventListener("pointercancel", () => { gesture = null; });
    // Keep mouse/touch support for WebViews whose native range drag omits
    // Pointer Events. Opening clears the gesture, so compatibility events
    // cannot open a second editor.
    slider.addEventListener("mousedown", (event) => {
      if (event.button === 0) beginGesture(event.clientX, event.clientY);
    });
    window.addEventListener("mousemove", (event) => moveGesture(event.clientX, event.clientY), true);
    window.addEventListener("mouseup", endGesture);
    slider.addEventListener("touchstart", (event) => {
      gesture = null;
      if (event.touches.length === 1) beginGesture(event.touches[0].clientX, event.touches[0].clientY);
    }, { passive: true });
    window.addEventListener("touchmove", (event) => {
      if (event.touches.length === 1) moveGesture(event.touches[0].clientX, event.touches[0].clientY);
      else gesture = null;
    }, { passive: true, capture: true });
    window.addEventListener("touchend", endGesture);
    window.addEventListener("touchcancel", () => { gesture = null; });
    window.addEventListener("blur", () => { gesture = null; });
    slider.addEventListener("keydown", (event) => {
      const step = event.shiftKey ? 10 : 1;
      const current = toPosition(getValue());
      const next = {
        ArrowLeft: current - step, ArrowDown: current - step,
        ArrowRight: current + step, ArrowUp: current + step,
        PageDown: current - 10, PageUp: current + 10, Home: 0, End: 100,
      }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      change(toPercent(next));
    });

    const dialog = document.createElement("dialog");
    dialog.className = "volume-adjust-popover";
    dialog.tabIndex = -1;
    const isRemote = Boolean(slider.closest(".remote-setting-panel"));
    const stepClass = isRemote ? "ghost-button remote-step-button" : "toolbar-button ghost av-sync-step-button";
    const resetClass = isRemote ? "ghost-button remote-reset-button" : "toolbar-button ghost av-sync-reset-button";
    const inputClass = isRemote ? "remote-input-wrap" : "av-sync-input-wrap";
    dialog.innerHTML = `<form>
      <div class="volume-adjust-heading"><h2></h2><button type="button" class="rating-close" data-volume-close>×</button></div>
      <div class="volume-adjust-fields">
        <button type="button" class="${stepClass}" data-volume-step="-10">−10</button>
        <label class="${inputClass}"><input type="number" min="0" max="500" step="1" inputmode="numeric" required><span>%</span></label>
        <button type="button" class="${stepClass}" data-volume-step="10">+10</button>
      </div>
      <button type="button" class="${resetClass}" data-volume-reset></button>
      <p class="volume-adjust-error" role="alert" hidden></p>
    </form>`;
    document.body.append(dialog);
    const form = dialog.querySelector("form");
    const input = dialog.querySelector("input");
    const heading = dialog.querySelector("h2");
    const close = dialog.querySelector("[data-volume-close]");
    const reset = dialog.querySelector("[data-volume-reset]");
    if (isRemote) close.autofocus = true;
    const errorMessage = dialog.querySelector(".volume-adjust-error");
    let busy = false;
    let closing = false;
    let songEpoch = 0;
    songResetHandlers.set(slider, (percent) => {
      songEpoch += 1;
      gesture = null;
      input.value = String(percent);
      reset.disabled = busy || percent === 100;
      errorMessage.hidden = true;
      render(slider, value, percent);
    });
    const position = () => {
      if (!dialog.open) return;
      const anchor = (isRemote ? slider : value).getBoundingClientRect();
      const viewport = window.visualViewport;
      const width = viewport?.width || window.innerWidth;
      const height = viewport?.height || window.innerHeight;
      const left = viewport?.offsetLeft || 0;
      const top = viewport?.offsetTop || 0;
      const box = { width: dialog.offsetWidth, height: dialog.offsetHeight };
      const thumbX = anchor.left + 10 + Math.max(0, anchor.width - 20) * toPosition(getValue()) / 100;
      const x = (isRemote ? thumbX + 20 : anchor.right) - box.width;
      let y = anchor.top - box.height - 8;
      if (isRemote && y < top + 12 && anchor.bottom + box.height + 8 <= top + height - 12) {
        y = anchor.bottom + 8;
      }
      dialog.style.left = `${Math.max(left + 12, Math.min(x, left + width - box.width - 12))}px`;
      dialog.style.top = `${Math.max(top + 12, Math.min(y, top + height - box.height - 12))}px`;
    };
    function dismiss() {
      if (busy || closing || !dialog.open) return;
      closing = true;
      dialog.classList.add("closing");
      const animations = dialog.getAnimations();
      Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
        dialog.close();
        dialog.classList.remove("closing");
        closing = false;
      });
    }
    function openDialog() {
      if (dialog.open) return;
      heading.textContent = t("player.volumeAdjust");
      dialog.setAttribute("aria-label", t("player.volumeAdjust"));
      input.setAttribute("aria-label", t("player.volumeTag"));
      close.setAttribute("aria-label", t("common.close"));
      reset.textContent = t("common.resetShort");
      errorMessage.hidden = true;
      input.value = String(bounded(getValue()));
      reset.disabled = bounded(getValue()) === 100;
      // showModal performs native autofocus before our anchored positioning.
      // Preserve the underlying sheet's scroll offset across that focus step.
      const scrollers = isRemote ? [...document.querySelectorAll('.playback-sheet-body')]
        .map(element => [element, element.scrollTop, element.scrollLeft]) : [];
      dialog.showModal();
      value.setAttribute("aria-expanded", "true");
      position();
      for (const [element, top, left] of scrollers) element.scrollTo({top, left, behavior: "instant"});
      // Opening the mobile editor should not immediately summon its keyboard.
      if (isRemote) close.focus({ preventScroll: true });
      else {
        input.focus({ preventScroll: true });
        input.select();
      }
    }
    value.addEventListener("click", openDialog);
    close.addEventListener("click", async () => {
      if (busy || closing) return;
      if (input.validity.valid && bounded(input.value) !== bounded(getValue())) {
        await applyValue(bounded(input.value), close);
        if (!errorMessage.hidden) return;
      }
      dismiss();
    });
    dialog.addEventListener("keydown", (event) => {
      // Keep the parent playback sheet's Escape/Tab handlers below this dialog.
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss();
      } else if (event.key === "Enter" && event.target === input) {
        event.preventDefault();
        applyInput();
      }
    });
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); dismiss(); });
    dialog.addEventListener("close", () => value.setAttribute("aria-expanded", "false"));
    let backdropPressed = false;
    const trackBackdropPress = (event) => { backdropPressed = event.target === dialog; };
    dialog.addEventListener("mousedown", trackBackdropPress);
    dialog.addEventListener("touchstart", trackBackdropPress, { passive: true });
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog || !backdropPressed) return;
      backdropPressed = false;
      const box = dialog.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dismiss();
    });
    // Keep a button click from first blurring/submitting the numeric draft.
    // The step/reset action applies its final value in one request.
    form.addEventListener("pointerdown", (event) => {
      if ((isRemote || document.activeElement === input) && event.target.closest("button")) event.preventDefault();
    });
    dialog.querySelectorAll("[data-volume-step]").forEach((button) => {
      button.addEventListener("click", () => {
        if (button.disabled || busy || closing) return;
        const current = input.validity.valid ? Number(input.value) : bounded(getValue());
        applyValue(bounded(current + Number(button.dataset.volumeStep)), button);
      });
    });
    reset.addEventListener("click", () => {
      if (!reset.disabled) applyValue(100, reset);
    });
    input.addEventListener("input", () => {
      if (!busy) reset.disabled = input.validity.valid && Number(input.value) === 100 && bounded(getValue()) === 100;
    });
    function applyInput() {
      if (!busy && !closing && form.reportValidity()) applyValue(bounded(input.value), input);
    }
    input.addEventListener("change", applyInput);
    form.addEventListener("submit", (event) => { event.preventDefault(); applyInput(); });
    async function applyValue(percent, activeControl) {
      if (busy || closing) return;
      input.value = String(percent);
      errorMessage.hidden = true;
      if (percent === bounded(getValue())) {
        reset.disabled = percent === 100;
        return;
      }
      busy = true;
      const requestEpoch = songEpoch;
      const controls = [...form.querySelectorAll("button, input")];
      const disabled = controls.map((element) => element.disabled);
      controls.forEach((element) => { element.disabled = true; });
      // Disabling the focused control must not send Escape/Tab to the sheet
      // underneath this modal while the write is in flight.
      dialog.focus({ preventScroll: true });
      activeControl.setAttribute("aria-busy", "true");
      try {
        const result = await onCommit(percent);
        if (result === false && requestEpoch === songEpoch) {
          errorMessage.textContent = t("player.volumeSaveFailed");
          errorMessage.hidden = false;
        }
      } catch (error) {
        // The setter rolls back; keep feedback inside the active modal too.
        if (requestEpoch === songEpoch) {
          errorMessage.textContent = error?.message || t("player.volumeSaveFailed");
          errorMessage.hidden = false;
        }
      } finally {
        controls.forEach((element, index) => { element.disabled = disabled[index]; });
        activeControl.removeAttribute("aria-busy");
        busy = false;
        input.value = String(bounded(getValue()));
        reset.disabled = bounded(getValue()) === 100;
        if (dialog.open && (document.activeElement === dialog || !dialog.contains(document.activeElement))) {
          (activeControl.disabled ? close : activeControl).focus({ preventScroll: true });
        }
        position();
      }
    }
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    render(slider, value, getValue());
  }

  globalThis.BilikaraVolumeControl = { bind, render, resetForSong, toPosition, toPercent };
})();
