/* An optional, inline presentation of the existing browse search forms. */
(function (root) {
  "use strict";
  const controls = new WeakMap();
  let nextId = 0;
  const searchIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/>'
    + '<path d="m15.5 15.5 5 5"/></svg>';
  const closeIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
  const busyIcon = '<svg class="browse-search-spinner" viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M12 3a9 9 0 1 1-9 9"/></svg>';

  function create(form, context) {
    const input = form.querySelector("input");
    const submit = form.querySelector('button[type="submit"]');
    const bar = document.createElement("div");
    bar.className = "browse-search-bar";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "browse-search-cancel";
    cancel.innerHTML = closeIcon;
    context.before(bar);
    bar.append(context, cancel, form);
    context.classList.add("browse-search-context");
    form.classList.add("browse-search-form");
    form.setAttribute("role", "search");
    submit.removeAttribute("data-i18n");
    input.removeAttribute("data-i18n-placeholder");
    input.id ||= `browse-search-query-${++nextId}`;
    input.setAttribute("enterkeyhint", "search");
    submit.setAttribute("aria-controls", input.id);
    let options, key, opened = false, clearing = false, draft = input.value;

    function render() {
      const { translate, loading, title } = options;
      const scope = translate("search.inScope", { scope: title });
      bar.classList.toggle("is-open", opened);
      context.inert = opened;
      context.setAttribute("aria-hidden", String(opened));
      input.value = draft;
      input.placeholder = scope;
      input.setAttribute("aria-label", scope);
      input.tabIndex = opened ? 0 : -1;
      form.setAttribute("aria-label", scope);
      form.setAttribute("aria-busy", String(loading));
      submit.innerHTML = loading ? busyIcon : searchIcon;
      submit.setAttribute("aria-expanded", String(opened));
      submit.setAttribute("aria-label", loading ? translate("search.browseLoading")
        : opened ? translate("search.submit") : scope);
      submit.title = submit.getAttribute("aria-label");
      cancel.setAttribute("aria-label", translate("search.cancelInline"));
      cancel.title = cancel.getAttribute("aria-label");
      cancel.hidden = !opened;
      for (const element of [input, submit, cancel]) {
        element.disabled = loading;
        if (loading) element.setAttribute("aria-busy", "true");
        else element.removeAttribute("aria-busy");
      }
    }

    function open() {
      if (options.loading) return;
      opened = true;
      render();
      // Synchronous focus keeps this inside the touch activation on mobile.
      input.focus({ preventScroll: true });
    }

    function close() {
      if (options.loading) return;
      clearing = Boolean(options.query);
      draft = "";
      opened = false;
      input.blur();
      render();
      submit.focus({ preventScroll: true });
      // Reuse the existing request owner to restore unfiltered results.
      // A draft that was never submitted does not trigger a request.
      if (clearing) form.requestSubmit(submit);
    }

    form.addEventListener("click", event => {
      if (opened || options.loading) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      open();
    }, true);
    form.addEventListener("submit", event => {
      if (options.loading || (!opened && !clearing)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!options.loading) open();
        return;
      }
      draft = input.value;
      input.blur();
    }, true);
    input.addEventListener("input", () => { draft = input.value; });
    bar.addEventListener("keydown", event => {
      if (event.key !== "Escape" || !opened || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    });
    cancel.addEventListener("click", close);

    return {
      sync(value) {
        options = value;
        if (key !== options.key || (clearing && !options.loading)) {
          key = options.key;
          clearing = false;
          draft = options.query || "";
          opened = Boolean(draft);
        }
        // Failed clears must leave the still-active filter visible.
        if (!opened && options.query && !clearing) {
          draft = options.query;
          opened = true;
        }
        render();
      },
      reset() {
        key = undefined;
        draft = "";
        opened = clearing = false;
        options = { ...options, query: "", loading: false };
        render();
      },
    };
  }

  root.BilikaraBrowseSearch = {
    sync(form, context, options) {
      if (!form || !context) return;
      if (!controls.has(form)) controls.set(form, create(form, context));
      controls.get(form).sync(options);
    },
    reset(form) { controls.get(form)?.reset(); },
  };
})(window);
