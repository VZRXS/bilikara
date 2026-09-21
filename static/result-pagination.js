/* Remote result navigation. This owns only the current read-only UI page. */
(function (root) {
  "use strict";
  const pageSize = 6;
  const maximumPage = Math.floor(100000 / pageSize) + 1;
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

  function compactCount(value, language) {
    if (count(value) === null) return "?";
    const units = language === "en"
      ? [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "k"]]
      : [[1e12, language === "ja" ? "兆" : "万亿"],
        [1e8, language === "ja" ? "億" : "亿"], [1e4, "万"], [1e3, "千"]];
    for (let index = 0; index < units.length; index++) {
      const [scale, suffix] = units[index];
      if (value < scale) continue;
      const rounded = Math.round(value / scale * 10) / 10;
      // Carry a rounded boundary into the next unit (999.95k becomes 1M).
      if (index > 0 && rounded * scale >= units[index - 1][0]) {
        return `1${units[index - 1][1]}`;
      }
      return `${rounded}${suffix}`;
    }
    return String(value);
  }

  class Pages {
    constructor(onChange = () => {}) {
      this.onChange = onChange;
      this.version = 0;
      this.cache = new Map();
      this.page = 1;
      this.items = [];
      this.busy = false;
      this.externalBusy = false;
      this.total = null;
    }

    update(options) {
      const changed = this.sourceKey !== options.key || this.initialItems !== options.items;
      this.load = options.load;
      this.readAhead = options.readAhead === 2 ? 2 : 0;
      this.limited = Boolean(options.limited);
      if (changed || (options.loading && !this.externalBusy)) {
        this.version += 1;
        this.busy = false;
      }
      this.externalBusy = Boolean(options.loading);
      if (changed) {
        this.sourceKey = options.key;
        this.initialItems = options.items;
        this.total = count(options.total);
        this.hasMore = Boolean(options.hasMore);
        this.initialHasMore = this.hasMore;
        this.page = 1;
        this.items = options.items.slice(0, pageSize);
        this.cache.clear();
        for (let start = 0; start < options.items.length; start += pageSize) {
          const items = options.items.slice(start, start + pageSize);
          if (items.length === pageSize || !this.hasMore) {
            this.remember(start / pageSize + 1, items);
          }
        }
        // The first page stays available even when a provider returns a short page.
        this.remember(1, this.items);
      }
      this.onChange();
    }

    remember(page, items) {
      this.cache.set(page, items);
      while (this.cache.size > 12) {
        const oldest = Array.from(this.cache.keys()).find(key => key !== this.page);
        this.cache.delete(oldest);
      }
    }

    get pageCount() {
      return this.total === null ? null : Math.max(1, Math.ceil(this.total / pageSize));
    }

    get loading() { return this.busy || this.externalBusy; }

    get lastPage() { return Math.min(this.pageCount ?? maximumPage, maximumPage); }

    get canNext() {
      return this.page < this.lastPage
        && (this.pageCount !== null || this.cache.has(this.page + 1) || this.hasMore);
    }

    async goTo(page) {
      if (this.loading || page === this.page) return false;
      if (!Number.isSafeInteger(page) || page < 1 || page > this.lastPage) {
        throw new RangeError("page_out_of_range");
      }
      const start = (page - 1) * pageSize;
      if (!this.cache.has(page) && start < this.initialItems.length
        && (start + pageSize <= this.initialItems.length || !this.initialHasMore)) {
        this.remember(page, this.initialItems.slice(start, start + pageSize));
      }
      if (this.cache.has(page)) {
        this.page = page;
        this.items = this.cache.get(page);
        this.onChange();
        return true;
      }
      if (typeof this.load !== "function") throw new RangeError("page_out_of_range");
      const version = ++this.version;
      const offset = (page - 1) * pageSize;
      this.busy = true;
      this.onChange();
      try {
        // A shared-catalog read includes this page and at most its next two.
        // Cached page turns do not start another read or a background worker.
        const limit = pageSize * (1 + this.readAhead);
        const data = await this.load({ offset, limit });
        if (version !== this.version) return false;
        if (!Array.isArray(data?.items)
          || (data.offset !== undefined && data.offset !== offset)
          || (data.has_more && (!Number.isSafeInteger(data.next_offset) || data.next_offset <= offset))) {
          throw new Error("invalid_result_page");
        }
        if (!data.items.length) throw new RangeError("page_out_of_range");
        if (data.items.length > limit) throw new Error("invalid_result_page");
        const total = count(data.matched_count);
        this.total = total ?? (data.has_more === false ? offset + data.items.length : this.total);
        this.hasMore = Boolean(data.has_more);
        this.page = page;
        this.items = data.items.slice(0, pageSize);
        for (let start = pageSize; start < data.items.length; start += pageSize) {
          const items = data.items.slice(start, start + pageSize);
          if (items.length === pageSize || !this.hasMore) this.remember(page + start / pageSize, items);
        }
        this.remember(page, this.items);
        this.onChange();
        return true;
      } catch (error) {
        // An abandoned source must not surface its failure in the new view.
        if (version !== this.version) return false;
        throw error;
      } finally {
        if (version === this.version) {
          this.busy = false;
          this.onChange();
        }
      }
    }
  }

  function swipeDirection(dx, dy) {
    return Math.abs(dx) >= 64 && Math.abs(dx) > Math.abs(dy) * 1.6
      ? (dx < 0 ? 1 : -1) : 0;
  }

  // Keep the window still while its three pages remain visible. Shift only at
  // an edge; reversing direction first moves the highlight within that window.
  function dotWindow(page, total, previousStart = 1) {
    const length = Math.min(3, total ?? 3);
    const start = Math.max(1, Math.min(
      Math.max(page - length + 1, Math.min(previousStart, page)),
      total === null ? maximumPage - length + 1 : total - length + 1,
    ));
    return Array.from({ length }, (_, index) => start + index);
  }

  function create(container, { translate, renderItems, reportError }) {
    const pager = document.createElement("nav");
    pager.className = "result-pager";
    pager.tabIndex = 0;
    pager.innerHTML = '<span class="result-pager-count"></span>'
      + '<div class="result-pager-controls"><button type="button" class="result-pager-dots" data-page-dots></button>'
      + '<form class="result-pager-editor"><label class="result-pager-input"><input type="text" inputmode="numeric"'
      + ' pattern="[0-9]*" maxlength="5" enterkeyhint="go" data-page-input></label><span class="result-pager-total">'
      + '<span aria-hidden="true"></span><span class="result-pager-exact"></span></span>'
      + '<button type="submit" data-page-go>✓</button></form></div>'
      + '<span class="result-pager-items-total"><span aria-hidden="true"></span><span class="result-pager-exact"></span></span>'
      + '<span class="result-pager-measure" aria-hidden="true"></span>'
      + '<span class="result-pager-announcement" role="status" aria-live="polite"></span>';
    container.after(pager);
    container.classList.add("has-result-pages");
    const editor = pager.querySelector("form");
    const submit = pager.querySelector("[data-page-go]");
    const input = pager.querySelector("[data-page-input]");
    const summary = pager.querySelector(".result-pager-count");
    const itemTotal = pager.querySelector(".result-pager-items-total");
    const dots = pager.querySelector(".result-pager-dots");
    const totalLabel = pager.querySelector(".result-pager-total");
    const announcement = pager.querySelector(".result-pager-announcement");
    const measure = pager.querySelector(".result-pager-measure");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let options = {}, renderedItems = null, renderedLanguage = "", renderedEmpty = "";
    let drag = null, suppressClick = false, idleTimer = null;
    let visibleDots = [], dotPage = 1, dotLanguage = "", wide = false;
    let navigationVersion = 0;
    let inputDraft = false;

    function textWidth(text) {
      measure.textContent = text;
      return measure.offsetWidth;
    }

    function layout() {
      if (!pager.getClientRects().length) return;
      // Wrapped side labels cannot tell us whether the wider layout fits.
      // Measure their intrinsic widths with the same inherited font instead.
      wide = pager.clientWidth >= editor.offsetWidth + 56
        + 2 * Math.max(textWidth(summary.textContent), textWidth(itemTotal.firstChild.textContent)) + 17;
      pager.classList.toggle("is-wide", wide);
      dots.setAttribute("aria-hidden", String(!wide));
      dots.tabIndex = wide ? 0 : -1;
      dots.disabled = !wide || model.loading || !model.items.length;
    }
    const resizeObserver = new ResizeObserver(layout);
    resizeObserver.observe(pager);
    resizeObserver.observe(summary);
    resizeObserver.observe(itemTotal);
    resizeObserver.observe(editor);

    function animate(element, frames, duration = 220) {
      if (reducedMotion.matches) return null;
      return element.animate(frames, { duration, easing: "ease-out" });
    }

    function drawDots() {
      const reset = visibleDots.length === 0;
      const pages = dotWindow(model.page, model.pageCount, reset ? 1 : visibleDots[0]);
      if (!reset && dotPage === model.page && dotLanguage === options.language
        && pages.join() === visibleDots.join()) return;
      const oldStart = visibleDots[0] ?? pages[0];
      const oldPage = dotPage;
      const outgoing = Array.from(dots.querySelectorAll("[data-dot-page]"))
        .filter(button => !pages.includes(Number(button.dataset.dotPage)));
      dots.replaceChildren();
      const scale = (page, start, length, current) => page !== current
        && ((page === start && start > 1)
          || (page === start + length - 1 && (model.pageCount === null || page < model.pageCount))) ? .67 : 1;
      for (const page of pages) {
        const indicator = document.createElement("span");
        indicator.className = "result-pager-dot";
        indicator.dataset.dotPage = String(page);
        indicator.setAttribute("aria-hidden", "true");
        if (page === model.page) indicator.setAttribute("aria-current", "page");
        indicator.innerHTML = '<span></span>';
        const x = (3 - pages.length) * 7 + (page - pages[0]) * 14;
        indicator.style.transform = `translateX(${x}px)`;
        const size = scale(page, pages[0], pages.length, model.page);
        indicator.firstChild.style.transform = `scale(${size})`;
        dots.append(indicator);
        if (!reset && visibleDots.length) {
          animate(indicator, [{ transform: `translateX(${(3 - visibleDots.length) * 7 + (page - oldStart) * 14}px)` },
            { transform: `translateX(${x}px)` }]);
          animate(indicator.firstChild, [{ opacity: page === oldPage ? 1 : .28,
            transform: `scale(${scale(page, oldStart, visibleDots.length, oldPage)})` },
          { opacity: page === model.page ? 1 : .28, transform: `scale(${size})` }]);
        }
      }
      if (!reset && !reducedMotion.matches) {
        for (const button of outgoing) {
          const page = Number(button.dataset.dotPage);
          button.setAttribute("aria-hidden", "true");
          button.removeAttribute("data-dot-page");
          dots.append(button);
          const from = button.style.transform;
          const animation = animate(button, [{ transform: from }, {
            transform: `translateX(${(page - pages[0]) * 14}px)`,
            opacity: 0,
          }]);
          animation.finished.then(() => button.remove(), () => button.remove());
        }
      }
      visibleDots = pages;
      dotPage = model.page;
      dotLanguage = options.language;
    }

    function showDots() {
      clearTimeout(idleTimer);
      pager.classList.add("is-interacting");
    }
    function rest() {
      clearTimeout(idleTimer);
      // This only restores the numeric label. Request completion owns all busy guards.
      idleTimer = setTimeout(() => pager.classList.remove("is-interacting"), 850);
    }
    function closeEditor() {
      inputDraft = false;
      editor.classList.remove("is-editing");
      input.value = String(model.page);
      sizeInput();
    }
    function sizeInput() {
      input.style.width = `${Math.min(6, Math.max(4, input.value.length + 1))}ch`;
    }
    function openEditor() {
      clearTimeout(idleTimer);
      pager.classList.remove("is-interacting");
      editor.classList.add("is-editing");
      input.select();
    }

    function setCountLabel(element, text, exact) {
      element.firstChild.textContent = text;
      element.lastChild.textContent = exact;
      element.title = exact;
    }

    const model = new Pages(() => {
      pager.setAttribute("aria-label", translate("pagination.label"));
      pager.setAttribute("aria-busy", String(model.loading));
      container.setAttribute("aria-busy", String(model.loading));
      container.inert = model.loading;
      pager.dataset.page = String(model.page);
      input.setAttribute("aria-label", translate("pagination.pageInput"));
      submit.setAttribute("aria-label", translate("pagination.go"));
      dots.setAttribute("aria-label", translate("pagination.turnPage", { page: model.page }));
      const pages = compactCount(model.pageCount, options.language);
      setCountLabel(totalLabel, `/ ${pages}`, translate("pagination.totalPages", { count: model.pageCount ?? "?" }));
      editor.style.setProperty("--page-total-width", `${pages.length + 3}ch`);
      if (!inputDraft || model.loading) {
        input.value = String(model.page);
        inputDraft = false;
      }
      sizeInput();
      const start = model.items.length ? (model.page - 1) * pageSize + 1 : 0;
      const end = start ? start + model.items.length - 1 : 0;
      // Keep the input and range exact: compacting both ends could show 10万–10万.
      summary.textContent = `${start}–${end}`;
      summary.setAttribute("aria-label", translate("pagination.range", { start, end }));
      const countKey = model.total === null ? "pagination.countUnknown"
        : model.limited ? "pagination.countReturned" : "pagination.countTotal";
      setCountLabel(itemTotal, translate(countKey, { count: compactCount(model.total, options.language) }),
        translate(countKey, { count: model.total }));
      drawDots();
      for (const control of [input, submit, dots]) {
        control.disabled = model.loading || !model.items.length;
        if (model.loading) control.setAttribute("aria-busy", "true");
        else control.removeAttribute("aria-busy");
      }
      if (renderedItems !== model.items || renderedLanguage !== options.language || renderedEmpty !== options.emptyText) {
        renderedItems = model.items;
        renderedLanguage = options.language;
        renderedEmpty = options.emptyText;
        renderItems(model.items, options.emptyText);
      }
      pager.hidden = container.classList.contains("hidden") || (!model.items.length && model.loading);
      layout();
    });

    async function navigate(page) {
      if (model.loading || page === model.page) return;
      closeEditor();
      const ticket = ++navigationVersion;
      const direction = Math.sign(page - model.page);
      showDots();
      try {
        if (await model.goTo(page)) {
          if (!pager.getClientRects().length) return;
          const top = container.getBoundingClientRect().top + window.scrollY - 8;
          window.scrollTo({ top: Math.max(0, top), behavior: "auto" });
          animate(container, [{ opacity: .5, transform: `translateX(${direction * 16}px)` },
            { opacity: 1, transform: "translateX(0)" }]);
          announcement.textContent = translate("pagination.changed", { page: model.page });
        }
      } catch (error) {
        input.value = String(model.page);
        if (!pager.getClientRects().length) return;
        const message = error instanceof RangeError
          ? translate("pagination.invalidPage")
          : error.message === "invalid_result_page"
            ? translate("pagination.invalidResponse") : error.message;
        reportError(message);
      } finally {
        if (ticket === navigationVersion) rest();
      }
    }
    input.addEventListener("focus", openEditor);
    input.addEventListener("input", () => {
      inputDraft = input.value !== String(model.page);
      sizeInput();
    });
    dots.addEventListener("click", event => {
      const rect = dots.getBoundingClientRect();
      const direction = event.detail === 0 || event.clientX >= rect.left + rect.width / 2 ? 1 : -1;
      if (direction < 0 ? model.page > 1 : model.canNext) navigate(model.page + direction);
    });
    editor.addEventListener("submit", event => {
      event.preventDefault();
      const page = /^[0-9]+$/.test(input.value.trim()) ? Number(input.value) : NaN;
      closeEditor();
      document.activeElement?.blur();
      navigate(page);
    });
    editor.addEventListener("focusout", event => {
      // Focus may move during a browser/layout update. Only submission,
      // cancellation or a source/page change discards an entered number.
      if (!editor.contains(event.relatedTarget)) editor.classList.toggle("is-editing", inputDraft);
    });
    pager.addEventListener("keydown", event => {
      if (event.key === "Escape" && editor.classList.contains("is-editing")) {
        event.preventDefault(); closeEditor(); input.blur(); return;
      }
      if (event.target === input || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = { ArrowLeft: model.page - 1, ArrowRight: model.page + 1,
        Home: 1, End: model.pageCount === null ? model.page : model.lastPage }[event.key];
      if (target === undefined) return;
      event.preventDefault();
      if (target >= 1 && (target <= model.page || model.canNext)) navigate(target);
    });

    function finishDrag(event, cancelled = false) {
      if (!drag || drag.id !== event.pointerId) return;
      const direction = cancelled ? 0 : swipeDirection(event.clientX - drag.x, event.clientY - drag.y);
      const horizontal = drag.horizontal;
      drag = null;
      if (container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId);
      if (horizontal) rest();
      if (!direction) return;
      suppressClick = true;
      if ((direction > 0 && model.canNext) || (direction < 0 && model.page > 1)) navigate(model.page + direction);
    }
    container.addEventListener("pointerdown", event => {
      suppressClick = false;
      if (!event.isPrimary || model.loading || (event.pointerType === "mouse" && event.button !== 0)) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, horizontal: false };
    }, { passive: true });
    container.addEventListener("pointermove", event => {
      if (!drag || drag.id !== event.pointerId) return;
      const dx = Math.abs(event.clientX - drag.x), dy = Math.abs(event.clientY - drag.y);
      if (!drag.horizontal && dy > 12 && dy >= dx) { drag = null; return; }
      if (!drag.horizontal && dx > 12 && dx > dy * 1.6) {
        drag.horizontal = true;
        suppressClick = true;
        container.setPointerCapture(event.pointerId);
        showDots();
      }
    }, { passive: true });
    container.addEventListener("pointercancel", event => finishDrag(event, true));
    container.addEventListener("lostpointercapture", event => {
      // Touch starts with implicit capture on the card's child. Transferring
      // it to the grid emits a bubbling loss on that child, not a cancellation.
      if (event.target === container && !container.hasPointerCapture(event.pointerId)) finishDrag(event, true);
    });
    container.addEventListener("pointerup", event => finishDrag(event));
    container.addEventListener("dragstart", event => event.preventDefault());
    container.addEventListener("click", event => {
      if (!suppressClick || event.detail === 0) return;
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    return {
      update(value) {
        if (options.key !== value.key || options.items !== value.items) {
          navigationVersion += 1;
          clearTimeout(idleTimer);
          pager.classList.remove("is-interacting");
          closeEditor();
          drag = null;
          visibleDots = [];
        }
        options = value;
        model.update(value);
      },
      localize(language) {
        options.language = language;
        if (!pager.hidden) model.onChange();
      },
      hide() {
        model.version += 1;
        navigationVersion += 1;
        model.busy = false;
        renderedItems = null;
        drag = null;
        clearTimeout(idleTimer);
        pager.classList.remove("is-interacting");
        closeEditor();
        pager.hidden = true;
        container.inert = false;
        container.removeAttribute("aria-busy");
      },
    };
  }

  const api = { Pages, pageSize, maximumPage, compactCount, swipeDirection, dotWindow, create };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BilikaraResultPager = api;
})(typeof window === "undefined" ? null : window);
