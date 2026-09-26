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
      this.direction = 1;
      this.items = [];
      this.busy = false;
      this.externalBusy = false;
      this.total = null;
      this.pageSize = pageSize;
    }

    update(options) {
      const size = [3, 6, 9, 12, 15, 18, 21, 24, 30, 36, 42, 48].includes(options.pageSize) ? options.pageSize : pageSize;
      const sameSource = this.sourceKey === options.key && this.initialItems === options.items;
      const firstItem = (this.page - 1) * this.pageSize;
      const changed = !sameSource || this.pageSize !== size;
      this.pageSize = size;
      this.load = options.load;
      this.readAhead = options.readAhead === 2 ? 2 : 0;
      this.readSize = options.readSize === 72 ? 72 : Math.min(96, size * (1 + this.readAhead));
      this.limited = Boolean(options.limited);
      this.prefetchEnabled = Boolean(options.prefetch);
      this.shouldPrefetch = options.shouldPrefetch;
      if (changed || (options.loading && !this.externalBusy)) {
        this.version += 1;
        this.busy = false;
        this.prefetchPending = null;
        this.prefetchAttempt = null;
      }
      this.externalBusy = Boolean(options.loading);
      if (changed) {
        this.sourceKey = options.key;
        this.initialItems = options.items;
        this.total = count(options.total);
        this.hasMore = Boolean(options.hasMore);
        this.initialHasMore = this.hasMore;
        this.page = sameSource ? Math.floor(firstItem / size) + 1 : 1;
        this.direction = 1;
        this.items = options.items.slice((this.page - 1) * size, this.page * size);
        this.cache.clear();
        for (let start = 0; start < options.items.length; start += size) {
          const items = options.items.slice(start, start + size);
          if (items.length === size || !this.hasMore) {
            this.remember(start / size + 1, items);
          }
        }
        // The first page stays available even when a provider returns a short page.
        this.remember(this.page, this.items);
      }
      this.onChange();
      void this.prefetch();
    }

    remember(page, items) {
      this.cache.delete(page);
      this.cache.set(page, items);
      while (this.cache.size > 12) {
        const oldest = Array.from(this.cache.keys()).find(key => key !== this.page);
        this.cache.delete(oldest);
      }
    }

    get pageCount() {
      return this.total === null ? null : Math.max(1, Math.ceil(this.total / this.pageSize));
    }

    get loading() { return this.busy || this.externalBusy; }

    get lastPage() { return Math.min(this.pageCount ?? maximumPage, Math.floor(100000 / this.pageSize) + 1); }

    peek(page) {
      if (this.cache.has(page)) return this.cache.get(page);
      const start = (page - 1) * this.pageSize;
      return start >= 0 && start < this.initialItems.length
        && (start + this.pageSize <= this.initialItems.length || !this.initialHasMore)
        ? this.initialItems.slice(start, start + this.pageSize) : null;
    }

    get canNext() {
      return this.page < this.lastPage
        && (this.pageCount !== null || this.cache.has(this.page + 1) || this.hasMore);
    }

    validatePage(data, offset, limit) {
      if (!Array.isArray(data?.items) || data.items.length > limit
        || (data.offset !== undefined && data.offset !== offset)
        || (data.has_more && (!Number.isSafeInteger(data.next_offset) || data.next_offset <= offset))) {
        throw new Error("invalid_result_page");
      }
      if (!data.items.length) throw new RangeError("page_out_of_range");
    }

    async prefetch() {
      if (!this.prefetchEnabled || !this.readAhead || this.loading || this.prefetchPending
        || typeof this.load !== "function" || this.shouldPrefetch?.() === false) return;
      const neighbors = [this.direction, -this.direction].flatMap(direction =>
        Array.from({length:this.readAhead}, (_, index) => this.page + direction * (index + 1)));
      const missing = neighbors.find(next => next >= 1 && next <= this.lastPage && this.peek(next) === null
        && (next < this.page || this.total !== null || this.hasMore));
      if (!missing) return;
      // Backward reads include the current/adjacent page so filling the bounded
      // cache cannot evict the very page the next reverse swipe will need.
      const page = missing < this.page
        ? Math.max(1, this.page - Math.max(this.readAhead, Math.ceil(this.readSize / this.pageSize) - 2))
        : missing;
      const originPage = this.page;
      const version = this.version;
      const attempt = `${version}:${this.page}:${page}`;
      if (this.prefetchAttempt === attempt) return;
      this.prefetchAttempt = attempt;
      const offset = (page - 1) * this.pageSize;
      const limit = this.readSize;
      const pending = {page, end:page + Math.ceil(limit / this.pageSize), promise:null};
      this.prefetchPending = pending;
      pending.promise = (async () => {
        try {
          const data = await this.load({offset, limit});
          if (version !== this.version) return;
          this.validatePage(data, offset, limit);
          this.total = count(data.matched_count)
            ?? (data.has_more === false ? offset + data.items.length : this.total);
          this.hasMore = Boolean(data.has_more);
          for (let start = 0; start < data.items.length; start += this.pageSize) {
            const items = data.items.slice(start, start + this.pageSize);
            if (items.length === this.pageSize || !this.hasMore) this.remember(page + start / this.pageSize, items);
          }
          this.onChange();
        } catch (_) {
          // A speculative failure leaves the current page usable. Navigation
          // may retry, but SSE renders must not repeatedly hit the provider.
        } finally {
          if (this.prefetchPending === pending) this.prefetchPending = null;
          if (version !== this.version || this.page !== originPage) void this.prefetch();
        }
      })();
      await pending.promise;
    }

    async goTo(page) {
      const pageSize = this.pageSize;
      if (this.loading || page === this.page) return false;
      if (!Number.isSafeInteger(page) || page < 1 || page > this.lastPage) {
        throw new RangeError("page_out_of_range");
      }
      this.direction = page < this.page ? -1 : 1;
      const pending = this.prefetchPending;
      if (pending && page >= pending.page && page < pending.end) {
        const version = this.version;
        this.busy = true;
        this.onChange();
        await pending.promise;
        if (version !== this.version) return false;
        this.busy = false;
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
        void this.prefetch();
        return true;
      }
      if (typeof this.load !== "function") throw new RangeError("page_out_of_range");
      const version = ++this.version;
      const offset = (page - 1) * pageSize;
      this.busy = true;
      this.onChange();
      try {
        // Search batches fill the twelve-page cache within the 80-item cap.
        // Browse keeps its smaller window. Cached turns never start a read.
        const limit = this.readSize;
        const data = await this.load({ offset, limit });
        if (version !== this.version) return false;
        this.validatePage(data, offset, limit);
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
          void this.prefetch();
        }
      }
    }
  }

  function swipeDirection(dx, dy, horizontalLocked = false) {
    return Math.abs(dx) >= 64 && (horizontalLocked || Math.abs(dx) > Math.abs(dy) * 1.15)
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

  function create(container, { translate, renderItems, reportError, rows = 0 }) {
    const viewport = document.createElement("div");
    viewport.className = "result-page-viewport";
    container.before(viewport);
    viewport.append(container);
    const pager = document.createElement("nav");
    pager.className = "result-pager";
    pager.tabIndex = 0;
    // Font chevrons follow the text baseline and appear below the page number.
    // Center actual icon geometry in the same 44px control row instead.
    const arrow = (action, path) => `<button type="button" data-page-action="${action}">`
      + `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${path}"/></svg></button>`;
    pager.innerHTML = '<span class="result-pager-count"></span>'
      + '<div class="result-pager-controls">'
      + arrow("first", "M11 6 5 12 11 18 M19 6 13 12 19 18") + arrow("previous", "M15 6 9 12 15 18")
      + '<div class="result-pager-position"><span class="result-pager-dots" aria-hidden="true"></span>'
      + '<form class="result-pager-editor"><label class="result-pager-input"><input type="text" inputmode="numeric"'
      + ' pattern="[0-9]*" maxlength="5" enterkeyhint="go" data-page-input></label><span class="result-pager-total">'
      + '<span aria-hidden="true"></span><span class="result-pager-exact"></span></span>'
      + '<button type="submit" data-page-go>✓</button></form></div>'
      + arrow("next", "M9 6 15 12 9 18") + arrow("last", "M5 6 11 12 5 18 M13 6 19 12 13 18") + '</div>'
      + '<span class="result-pager-items-total"><span aria-hidden="true"></span><span class="result-pager-exact"></span></span>'
      + '<span class="result-pager-announcement" role="status" aria-live="polite"></span>';
    viewport.after(pager);
    container.classList.add("has-result-pages");
    const editor = pager.querySelector("form");
    const submit = pager.querySelector("[data-page-go]");
    const input = pager.querySelector("[data-page-input]");
    const summary = pager.querySelector(".result-pager-count");
    const itemTotal = pager.querySelector(".result-pager-items-total");
    const dots = pager.querySelector(".result-pager-dots");
    const totalLabel = pager.querySelector(".result-pager-total");
    const announcement = pager.querySelector(".result-pager-announcement");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let options = {}, renderedItems = null, renderedLanguage = "", renderedEmpty = "";
    let drag = null, suppressClick = false, idleTimer = null, preview = null, settling = false;
    let swipeAnimations = [];
    let visibleDots = [], dotPage = 1, dotLanguage = "";
    let navigationVersion = 0;
    let inputDraft = false;
    let viewportWidth = 0;

    function layout() {
      if (!pager.getClientRects().length) return;
      if (viewportWidth !== viewport.clientWidth) {
        viewportWidth = viewport.clientWidth;
        viewport.style.minHeight = "";
      }
      if (rows) {
        const columns = getComputedStyle(container).gridTemplateColumns.split(" ").length;
        const size = Math.max(1, Math.min(8, columns)) * rows;
        if (model.pageSize !== size) {
          cancelNavigation();
          model.update({...options, pageSize:size});
          return;
        }
      }
    }
    const resizeObserver = new ResizeObserver(layout);
    resizeObserver.observe(pager);

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
      for (const button of pager.querySelectorAll("[data-page-action]")) {
        const action = button.dataset.pageAction;
        button.setAttribute("aria-label", translate(`pagination.${action}`));
        button.title = translate(`pagination.${action}`);
        button.disabled = model.loading || !model.items.length || (
          action === "first" || action === "previous" ? model.page === 1
            : action === "last" ? model.pageCount === null || model.page === model.lastPage : !model.canNext);
      }
      const pages = compactCount(model.pageCount, options.language);
      setCountLabel(totalLabel, `/ ${pages}`, translate("pagination.totalPages", { count: model.pageCount ?? "?" }));
      editor.style.setProperty("--page-total-width", `${pages.length + 3}ch`);
      if (!inputDraft || model.loading) {
        input.value = String(model.page);
        inputDraft = false;
      }
      sizeInput();
      const start = model.items.length ? (model.page - 1) * model.pageSize + 1 : 0;
      const end = start ? start + model.items.length - 1 : 0;
      // Keep the input and range exact: compacting both ends could show 10万–10万.
      summary.textContent = `${start}–${end}`;
      summary.setAttribute("aria-label", translate("pagination.range", { start, end }));
      const countKey = model.total === null ? "pagination.countUnknown"
        : model.limited ? "pagination.countReturned" : "pagination.countTotal";
      setCountLabel(itemTotal, translate("pagination.countShort", { count: compactCount(model.total, options.language) }),
        translate(countKey, { count: model.total }));
      drawDots();
      for (const control of [input, submit]) {
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
      pager.hidden = container.classList.contains("hidden") || !model.items.length;
      layout();
    });

    function clearSwipe() {
      swipeAnimations.forEach(animation => animation.cancel());
      swipeAnimations = [];
      preview?.remove();
      preview = null;
      container.style.transform = "";
      container.classList.remove("is-page-dragging");
    }

    function cancelNavigation() {
      navigationVersion += 1;
      drag = null;
      settling = false;
      clearSwipe();
    }

    function pageStride() {
      const gap = parseFloat(getComputedStyle(viewport).getPropertyValue("--result-page-gap")) || 0;
      return container.clientWidth + gap;
    }

    function dragPreview(direction, distance) {
      const next = model.page + direction;
      if (!preview || Number(preview.dataset.previewPage) !== next) {
        preview?.remove();
        preview = container.cloneNode(false);
        preview.removeAttribute("id");
        preview.classList.remove("has-result-pages", "is-page-dragging", "hidden");
        preview.classList.add("result-page-preview");
        preview.dataset.previewPage = String(next);
        preview.inert = true;
        preview.setAttribute("aria-hidden", "true");
        const items = model.peek(next);
        renderItems(items || [], items ? options.emptyText : translate("search.browseLoading"), preview);
        viewport.append(preview);
      }
      preview.style.transform = `translateX(${direction * pageStride() + distance}px)`;
    }

    async function settleSwipe(distance, target, ticket) {
      const animations = [animate(container, [{transform:`translateX(${distance}px)`}, {transform:`translateX(${target}px)`}], 180)];
      if (preview) {
        const offset = Math.sign(Number(preview.dataset.previewPage) - model.page) * pageStride();
        animations.push(animate(preview, [{transform:`translateX(${offset + distance}px)`}, {transform:`translateX(${offset + target}px)`}], 180));
      }
      swipeAnimations = animations.filter(Boolean);
      await Promise.all(swipeAnimations.map(animation=>animation.finished.catch(()=>{})));
      if (ticket !== navigationVersion) return false;
      swipeAnimations = [];
      container.style.transform = `translateX(${target}px)`;
      if (preview) preview.style.transform = `translateX(${Math.sign(Number(preview.dataset.previewPage) - model.page) * pageStride() + target}px)`;
      return true;
    }

    async function navigate(page, distance = null) {
      if (settling || model.loading || page === model.page) return;
      settling = true;
      closeEditor();
      const ticket = ++navigationVersion;
      const direction = Math.sign(page - model.page);
      showDots();
      try {
        if (distance !== null && !await settleSwipe(distance, -direction * pageStride(), ticket)) return;
        if (!container.getClientRects().length) return;
        // Preserve document height on shorter pages, including the last page.
        viewport.style.minHeight = `${viewport.getBoundingClientRect().height}px`;
        if (await model.goTo(page) && ticket === navigationVersion) {
          clearSwipe();
          if (!pager.getClientRects().length) return;
          if (distance === null) animate(container, [{ opacity: .5, transform: `translateX(${direction * 16}px)` },
            { opacity: 1, transform: "translateX(0)" }]);
          announcement.textContent = translate("pagination.changed", { page: model.page });
        }
      } catch (error) {
        if (ticket !== navigationVersion) return;
        input.value = String(model.page);
        if (!pager.getClientRects().length) return;
        const message = error instanceof RangeError
          ? translate("pagination.invalidPage")
          : error.message === "invalid_result_page"
            ? translate("pagination.invalidResponse") : error.message;
        reportError(message);
      } finally {
        if (ticket === navigationVersion) {
          clearSwipe();
          settling = false;
          rest();
        }
      }
    }
    input.addEventListener("focus", openEditor);
    pager.addEventListener("click", event => {
      const button = event.target.closest("[data-page-action]");
      if (!button || button.disabled) return;
      const target = {first: 1, previous: model.page - 1, next: model.page + 1, last: model.lastPage};
      navigate(target[button.dataset.pageAction]);
    });
    input.addEventListener("input", () => {
      inputDraft = input.value !== String(model.page);
      sizeInput();
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

    async function restoreDrag(displacement) {
      settling = true;
      const ticket = ++navigationVersion;
      try { await settleSwipe(displacement, 0, ticket); }
      finally {
        if (ticket === navigationVersion) {
          clearSwipe();
          settling = false;
        }
      }
    }

    function finishDrag(event, cancelled = false) {
      if (!drag || drag.id !== event.pointerId) return;
      const horizontal = drag.horizontal;
      // Once the initial movement selected paging, later vertical drift must
      // not reclassify this gesture as page scrolling or cancel the page turn.
      const direction = cancelled || !horizontal ? 0 : swipeDirection(event.clientX - drag.x, event.clientY - drag.y, true);
      const displacement = drag.displacement || 0;
      drag = null;
      if (typeof event.pointerId === "number" && viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
      if (horizontal) rest();
      if (!direction) {
        if (horizontal) void restoreDrag(displacement);
        else clearSwipe();
        return;
      }
      suppressClick = true;
      if ((direction > 0 && model.canNext) || (direction < 0 && model.page > 1)) navigate(model.page + direction, displacement);
      else void restoreDrag(displacement);
    }
    viewport.addEventListener("pointerdown", event => {
      suppressClick = false;
      if (event.pointerType === "touch" || !event.isPrimary || model.loading || settling || (event.pointerType === "mouse" && event.button !== 0)) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, horizontal: false };
    }, { passive: true });
    function moveDrag(event) {
      if (!drag || drag.id !== event.pointerId) return;
      const dx = Math.abs(event.clientX - drag.x), dy = Math.abs(event.clientY - drag.y);
      if (!drag.horizontal && dy >= 8 && dy > dx * 1.15) { drag = null; return; }
      if (!drag.horizontal && dx >= 8 && dx > dy * 1.15) {
        drag.horizontal = true;
        suppressClick = true;
        if (typeof event.pointerId === "number") viewport.setPointerCapture(event.pointerId);
        showDots();
      }
      if (drag.horizontal) {
        const distance = event.clientX - drag.x;
        const canTurn = distance < 0 ? model.canNext : model.page > 1;
        drag.displacement = canTurn ? Math.sign(distance) * Math.min(Math.abs(distance), pageStride()) : distance * .2;
        container.classList.add("is-page-dragging");
        container.style.transform = `translateX(${drag.displacement}px)`;
        if (canTurn) dragPreview(distance < 0 ? 1 : -1, drag.displacement);
        else { preview?.remove();preview=null; }
      }
    }
    viewport.addEventListener("pointermove", event => {
      // Pointer motion arrives before the first touchmove's browser slop
      // threshold. Remember that initial intent, without capturing touch.
      moveDrag(event.pointerType === "touch"
        ? {pointerId:"touch", clientX:event.clientX, clientY:event.clientY} : event);
    }, { passive: true });
    // Touch Events let us cancel native vertical panning only after a sideways
    // intent is clear. Passive Pointer Events alone cannot stop Safari from
    // taking a diagonal drag and issuing pointercancel partway through it.
    viewport.addEventListener("touchstart", event => {
      if (event.touches.length !== 1) {
        if (drag?.id === "touch") finishDrag({pointerId:"touch"}, true);
        return;
      }
      suppressClick = false;
      if (model.loading || settling) return;
      const point = event.touches[0];
      drag = {id:"touch", touchId:point.identifier, x:point.clientX, y:point.clientY, horizontal:false};
    }, {passive:true});
    viewport.addEventListener("touchmove", event => {
      if (drag?.id !== "touch" || event.touches.length !== 1) return;
      if (!event.cancelable) {
        finishDrag({pointerId:"touch"}, true);
        return;
      }
      const point = [...event.touches].find(point => point.identifier === drag.touchId);
      if (!point) return;
      moveDrag({pointerId:"touch", clientX:point.clientX, clientY:point.clientY});
      if (drag?.horizontal) event.preventDefault();
    }, {passive:false});
    viewport.addEventListener("touchend", event => {
      if (drag?.id !== "touch") return;
      const point = [...event.changedTouches].find(point => point.identifier === drag.touchId);
      if (point) finishDrag({pointerId:"touch", clientX:point.clientX, clientY:point.clientY});
    }, {passive:true});
    viewport.addEventListener("touchcancel", () => {
      if (drag?.id === "touch") finishDrag({pointerId:"touch"}, true);
    }, {passive:true});
    viewport.addEventListener("pointercancel", event => finishDrag(
      event.pointerType === "touch" ? {pointerId:"touch"} : event, true));
    viewport.addEventListener("lostpointercapture", event => {
      // Touch starts with implicit capture on the card's child. Transferring
      // it to the viewport emits a bubbling loss on that child, not a cancellation.
      if (event.target === viewport && !viewport.hasPointerCapture(event.pointerId)) finishDrag(event, true);
    });
    viewport.addEventListener("pointerup", event => finishDrag(event));
    viewport.addEventListener("dragstart", event => event.preventDefault());
    viewport.addEventListener("click", event => {
      if (!suppressClick || event.detail === 0) return;
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    return {
      update(value) {
        if (options.key !== value.key || options.items !== value.items) {
          cancelNavigation();
          viewport.style.minHeight = "";
          clearTimeout(idleTimer);
          pager.classList.remove("is-interacting");
          closeEditor();
          visibleDots = [];
        }
        options = value;
        const columns = rows ? getComputedStyle(container).gridTemplateColumns.split(" ").length : 1;
        model.update({...value, shouldPrefetch:() => Boolean(viewport.getClientRects().length), pageSize:rows ? Math.max(1, Math.min(8, columns)) * rows : value.pageSize});
      },
      localize(language) {
        options.language = language;
        if (!pager.hidden) model.onChange();
      },
      hide() {
        model.version += 1;
        cancelNavigation();
        model.busy = false;
        renderedItems = null;
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
