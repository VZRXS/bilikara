(function installSessionUserEditor(global) {
  "use strict";

  const icon = paths => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const pencil = icon('<path d="m16 3 5 5-12 12-6 1 1-6Z"/><path d="m14 5 5 5"/>');
  const checklist = icon('<path d="m3 6 2 2 3-3m-5 9 2 2 3-3M12 7h9M12 15h9"/>');
  const trash = icon('<path d="M3 6h18M19 6v14H5V6m4 0V3h6v3M10 10v7M14 10v7"/>');

  class SessionUserEditor {
    constructor({ stage, list, t, post, message, bindHelp }) {
      this.stage = stage;
      this.list = list;
      this.t = t;
      this.post = post;
      this.message = message;
      this.entries = [];
      this.selected = new Set();
      this.mode = "";
      this.openActionsId = "";
      this.busy = false;
      this.version = "";
      this.drag = null;
      this.editor = null;
      this.footer = document.createElement("div");
      this.footer.className = "session-user-tools";
      this.footer.innerHTML = `<button type="button" class="toolbar-button settings-tool-button session-user-select-all" hidden></button>
        <span class="session-user-selection-count" role="status"></span>
        <button type="button" class="session-user-mode-button" data-mode="rename" aria-pressed="false">${pencil}</button>
        <button type="button" class="session-user-mode-button" data-mode="select" aria-pressed="false">${checklist}</button>
        <span class="session-user-trash-slot cache-advanced-info" tabindex="0" aria-describedby="session-user-trash-help"><button type="button" id="session-user-trash" class="session-user-trash" data-contextual-info-anchor>${trash}</button><span id="session-user-trash-help" class="cache-advanced-tooltip" role="tooltip"></span></span>`;
      stage.querySelector("#session-user-trash")?.remove();
      stage.append(this.footer);
      this.trash = this.footer.querySelector(".session-user-trash");
      this.trashSlot = this.trash.parentElement;
      bindHelp?.(this.trashSlot);
      this.all = this.footer.querySelector(".session-user-select-all");
      this.count = this.footer.querySelector(".session-user-selection-count");
      this.footer.addEventListener("click", event => {
        if (this.busy) return;
        const mode = event.target.closest("[data-mode]");
        if (mode) this.setMode(this.mode === mode.dataset.mode ? "" : mode.dataset.mode);
        else if (event.target.closest(".session-user-select-all")) {
          this.selected = this.selected.size === this.entries.length ? new Set() : new Set(this.entries.map(user => user.id));
          this.sync();
        } else if (event.target.closest(".session-user-trash") && this.selected.size) {
          void this.commit({ action: "remove", user_ids: [...this.selected] });
        }
      });
      list.addEventListener("click", event => this.click(event));
      list.addEventListener("keydown", event => {
        if (["Enter", " "].includes(event.key) && event.target.matches(".session-user-name")) {
          event.preventDefault(); this.click(event);
        }
        if (this.mode === "select" && event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
          event.preventDefault(); this.moveSelection(event.key === "ArrowUp" ? -1 : 1);
        }
      });
      list.addEventListener("dragstart", event => this.dragStart(event));
      list.addEventListener("dragover", event => this.dragOver(event));
      list.addEventListener("drop", event => this.drop(event));
      list.addEventListener("dragend", () => this.finishDrag());
      this.trashSlot.addEventListener("dragover", event => {
        if (!this.drag || this.busy) return;
        event.preventDefault(); event.dataTransfer.dropEffect = "move"; this.trash.classList.add("drag-over");
      });
      this.trashSlot.addEventListener("dragleave", event => {
        // The fixed slot is the target; moving through the enlarged button or
        // its SVG must not toggle feedback while the pointer remains inside.
        if (this.trashSlot.contains(event.relatedTarget) || this.isOverTrash(event.clientX, event.clientY)) return;
        this.trash.classList.remove("drag-over");
      });
      this.trashSlot.addEventListener("drop", event => {
        if (!this.drag) return;
        event.preventDefault(); event.stopPropagation();
        const drag = this.drag; this.finishDrag();
        void this.commit({ action: "remove", user_ids: drag.ids }, drag.version);
      });
      // The numbered target owns touch dragging; swiping a tag's name or the
      // surrounding list still scrolls vertically, without changing tag sizes.
      list.addEventListener("pointerdown", event => this.pointerDown(event));
      list.addEventListener("pointermove", event => this.pointerMove(event));
      list.addEventListener("pointerup", event => this.pointerUp(event));
      list.addEventListener("pointercancel", event => {
        // Native HTML dragging itself cancels the mouse pointer stream.
        // Only a canceled touch/pen gesture should cancel our pointer drag.
        if (this.pointer?.id === event.pointerId) this.finishDrag();
      });
      document.addEventListener("keydown", event => {
        if (event.key === "Escape" && !this.busy) {
          this.closeEditor(); this.setMode(""); this.finishDrag();
        }
      });
      document.addEventListener("pointerdown", event => {
        if (this.editor && !this.busy && !this.editor.node.contains(event.target) && !event.target.closest(".session-user-badge")) this.closeEditor();
      });
      global.addEventListener("blur", () => this.finishDrag());
      global.addEventListener("resize", () => { this.finishDrag(); this.positionEditor(); });
      list.addEventListener("scroll", () => this.positionEditor(), { passive: true });
    }

    setMode(mode) {
      this.closeEditor();
      this.finishDrag();
      this.mode = mode;
      this.selected.clear(); this.openActionsId = "";
      this.sync();
    }

    render(snapshot) {
      const entries = Array.isArray(snapshot?.session_user_entries) ? snapshot.session_user_entries : [];
      const generation = `${snapshot?.state_epoch || ""}:${snapshot?.session_generation || 0}`;
      if (this.generation && this.generation !== generation) this.setMode("");
      this.generation = generation;
      this.version = String(snapshot?.session_users_version || "");
      this.entries = entries;
      const ids = new Set(entries.map(user => user.id));
      for (const id of this.selected) if (!ids.has(id)) this.selected.delete(id);
      if (this.drag && this.drag.version !== this.version) this.finishDrag();
      if (this.editor && !this.busy) {
        const current = entries.find(user => user.id === this.editor.id);
        if (!current || current.name !== this.editor.originalName) {
          this.closeEditor(); this.message(this.t("session.changed"), true);
        }
      }
      const signature = JSON.stringify(entries);
      if (signature !== this.signature) {
        this.signature = signature;
        const scrollTop = this.list.scrollTop;
        const badges = new Map([...this.list.querySelectorAll(".session-user-badge")].map(node => [node.dataset.userId, node]));
        for (const node of [...this.list.children]) if (!ids.has(node.dataset.userId)) node.remove();
        for (const [index, user] of entries.entries()) {
          let badge = badges.get(user.id);
          if (!badge) {
            badge = document.createElement("div");
            badge.className = "session-user-badge";
            badge.dataset.userId = user.id;
            badge.innerHTML = '<span class="session-user-order-number"><span class="session-user-number"></span><input type="checkbox" class="session-user-checkbox" hidden></span><span class="session-user-name android-user-toggle" role="button" tabindex="0" aria-expanded="false"></span><div class="android-user-actions" hidden><button type="button" data-user-action="up">↑</button><button type="button" data-user-action="down">↓</button><button type="button" data-user-action="remove"></button></div>';
          }
          badge.dataset.name = user.name;
          badge.dataset.index = String(index);
          badge.querySelector(".session-user-number").textContent = String(index + 1);
          badge.querySelector(".session-user-name").textContent = user.name;
          badge.querySelector(".session-user-checkbox").setAttribute("aria-label", this.t("session.selectUser", { name: user.name }));
          const position = this.list.children[index];
          if (position !== badge) this.list.insertBefore(badge, position || null);
        }
        if (!entries.length) {
          const empty = document.createElement("div");
          empty.className = "request-session-user-notice session-user-empty";
          empty.textContent = `${this.t("session.empty")} ${this.t("session.help")}`; empty.setAttribute("role", "status");
          this.list.append(empty);
        }
        this.list.scrollTop = scrollTop;
      }
      this.sync(); this.positionEditor();
    }

    sync() {
      this.coarse = Boolean(global.matchMedia?.("(pointer: coarse)").matches && !global.matchMedia?.("(any-pointer: fine)").matches);
      document.documentElement.dataset.hostTouchUsers = String(this.coarse);
      this.stage.dataset.editMode = this.mode;
      this.list.classList.toggle("is-empty", !this.entries.length);
      const empty = this.list.querySelector(".session-user-empty");
      if (empty) empty.textContent = `${this.t("session.empty")} ${this.t("session.help")}`;
      this.all.hidden = this.mode !== "select";
      this.all.disabled = this.busy || !this.entries.length;
      this.all.textContent = this.t(this.selected.size && this.selected.size === this.entries.length ? "session.clearSelection" : "session.selectAll");
      this.all.setAttribute("aria-pressed", String(Boolean(this.entries.length && this.selected.size === this.entries.length)));
      this.count.textContent = this.mode === "select" ? this.t("session.selectedCount", { count: this.selected.size }) : "";
      for (const button of this.footer.querySelectorAll("[data-mode]")) {
        button.disabled = this.busy || !this.version;
        button.setAttribute("aria-pressed", String(button.dataset.mode === this.mode));
        button.setAttribute("aria-label", this.t(button.dataset.mode === "rename" ? "session.renameMode" : "session.selectMode"));
        button.title = button.getAttribute("aria-label");
      }
      this.trash.disabled = this.busy || (!this.drag && (this.mode !== "select" || !this.selected.size));
      this.trash.setAttribute("aria-label", this.t("session.deleteSelected"));
      this.trashSlot.querySelector('.cache-advanced-tooltip').textContent = this.t("session.dragToDelete");
      if (this.busy) this.footer.setAttribute("aria-busy", "true"); else this.footer.removeAttribute("aria-busy");
      if (this.editor) {
        this.editor.node.setAttribute("aria-label", this.t("remoteIdentity.renameTitle"));
        this.editor.node.querySelector("label").textContent = this.t("remoteIdentity.renameTitle");
        this.editor.input.placeholder = this.t("session.namePlaceholder");
        this.editor.node.querySelector('.session-user-rename-cancel').textContent = this.t("common.cancel");
        this.editor.node.querySelector('.banner-close').setAttribute("aria-label", this.t("common.close"));
        this.editor.submit.textContent = this.t("common.confirm");
      }
      for (const badge of this.list.querySelectorAll(".session-user-badge")) {
        const selected = this.selected.has(badge.dataset.userId);
        badge.draggable = !this.coarse && !this.busy && this.mode !== "rename";
        const open = this.coarse && !this.mode && this.openActionsId === badge.dataset.userId;
        badge.classList.toggle("is-actions-open", open);
        badge.querySelector(".android-user-actions").hidden = !open;
        badge.querySelector(".session-user-name").setAttribute("aria-expanded", String(open));
        for (const button of badge.querySelectorAll("[data-user-action]")) {
          const action = button.dataset.userAction;
          button.disabled = this.busy || (action === "up" && badge.dataset.index === "0") || (action === "down" && Number(badge.dataset.index) === this.entries.length - 1);
          button.setAttribute("aria-label", this.t(action === "up" ? "common.moveUp" : action === "down" ? "common.moveDown" : "common.delete"));
          if (action === "remove") button.textContent = this.t("common.delete");
        }
        badge.classList.toggle("is-selected", selected);
        const checkbox = badge.querySelector(".session-user-checkbox");
        checkbox.hidden = this.mode !== "select"; checkbox.checked = selected; checkbox.disabled = this.busy;
        badge.querySelector(".session-user-number").hidden = this.mode === "select";
        badge.querySelector(".session-user-name").setAttribute("aria-label", this.mode === "rename" ? this.t("session.renameUser", { name: badge.dataset.name }) : badge.dataset.name);
      }
    }

    click(event) {
      if (this.suppressClick && event.timeStamp - this.suppressClick.time < 500 && event.target.closest(".session-user-badge")?.dataset.userId === this.suppressClick.id) {
        this.suppressClick = null; event.preventDefault(); return;
      }
      this.suppressClick = null;
      if (this.busy) return;
      const badge = event.target.closest(".session-user-badge");
      if (!badge) return;
      if (!this.mode && this.coarse) {
        const action = event.target.closest("[data-user-action]")?.dataset.userAction;
        if (!action) this.openActionsId = this.openActionsId === badge.dataset.userId ? "" : badge.dataset.userId;
        else if (action === "remove") void this.commit({ action: "remove", user_ids: [badge.dataset.userId] });
        else {
          const index = Number(badge.dataset.index);
          const before = action === "up" ? this.entries[index - 1] : this.entries[index + 2];
          void this.commit({ action: "reorder", user_ids: [badge.dataset.userId], before_user_id: before?.id || null });
        }
        this.sync();
      }
      else if (this.mode === "rename") this.openEditor(badge);
      else if (this.mode === "select") {
        const id = badge.dataset.userId;
        if (this.selected.has(id)) this.selected.delete(id); else this.selected.add(id);
        this.sync();
      }
    }

    async commit(edit, version = this.version) {
      if (this.busy) return;
      this.busy = true; this.sync();
      const editor = this.editor;
      if (editor) { editor.input.disabled = true; for (const button of editor.node.querySelectorAll("button")) button.disabled = true; editor.submit.setAttribute("aria-busy", "true"); }
      try {
        await this.post("/api/session-users/edit", { expected_version: version, edit });
        if (edit.action === "remove") this.selected.clear();
        if (edit.action === "rename") this.closeEditor();
        this.message(this.t(edit.action === "rename" ? "session.renamed" : edit.action === "remove" ? "session.usersRemoved" : "session.orderUpdated"));
      } catch (error) {
        this.message(error.code === "session_users_changed" ? this.t("session.changed") : error.message, true);
      } finally {
        this.busy = false;
        if (this.editor) {
          const current = this.entries.find(user => user.id === this.editor.id);
          if (!current || current.name !== this.editor.originalName) {
            this.closeEditor(); this.message(this.t("session.changed"), true);
          }
        }
        if (editor?.node.isConnected) { editor.input.disabled = false; for (const button of editor.node.querySelectorAll("button")) button.disabled = false; editor.submit.removeAttribute("aria-busy"); editor.input.focus({ preventScroll: true }); }
        this.sync();
      }
    }

    openEditor(badge) {
      this.closeEditor();
      const node = document.createElement("form");
      node.className = "session-user-rename-panel";
      node.setAttribute("role", "dialog"); node.setAttribute("aria-label", this.t("remoteIdentity.renameTitle"));
      node.innerHTML = `<div class="session-user-rename-head"><label class="session-user-rename-label"></label><button type="button" class="banner-close">${icon('<path d="m6 6 12 12M18 6 6 18"/>')}</button></div><input name="username" type="text" autocomplete="off" required><div class="session-user-rename-actions"><button type="button" class="toolbar-button session-user-rename-cancel"></button><button type="submit" class="next-button"></button></div>`;
      const input = node.querySelector("input");
      const submit = node.querySelector('[type="submit"]');
      const label = node.querySelector("label");
      input.id = "session-user-rename-input"; label.htmlFor = input.id;
      label.textContent = this.t("remoteIdentity.renameTitle");
      input.placeholder = this.t("session.namePlaceholder"); input.value = badge.dataset.name;
      node.querySelector('.session-user-rename-cancel').textContent = this.t("common.cancel");
      node.querySelector('.banner-close').setAttribute("aria-label", this.t("common.close"));
      submit.textContent = this.t("common.confirm");
      for (const button of node.querySelectorAll('[type="button"]')) button.addEventListener("click", () => { if (!this.busy) this.closeEditor(); });
      node.addEventListener("submit", event => {
        event.preventDefault();
        const name = input.value.trim();
        if (!name || Array.from(name).length > 24) { this.message(this.t("session.nameLength"), true); return; }
        void this.commit({ action: "rename", user_id: badge.dataset.userId, name });
      });
      node.addEventListener("keydown", event => {
        if (event.key === "Tab") {
          const focusable = [...node.querySelectorAll("input, button")].filter(control => !control.disabled);
          if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1).focus(); }
          else if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0].focus(); }
        }
      });
      document.body.append(node);
      if (typeof node.showPopover === "function") { node.setAttribute("popover", "manual"); node.showPopover(); }
      this.editor = { node, input, submit, anchor: badge, id: badge.dataset.userId, originalName: badge.dataset.name };
      this.positionEditor(); input.focus({ preventScroll: true }); input.select();
    }

    closeEditor({ restoreFocus = true } = {}) {
      const editor = this.editor;
      this.editor = null;
      if (!editor) return;
      const node = editor.node;
      node.classList.add("closing");
      node.inert = true;
      // A replacement editor may open before exit finishes. Keep this surface
      // and its coordinates, without duplicate live field IDs or callbacks
      // that could remove/focus the replacement.
      editor.input.removeAttribute("id");
      Promise.allSettled((node.getAnimations?.() || []).map(animation => animation.finished))
        .then(() => node.remove());
      if (restoreFocus && editor.anchor.isConnected) editor.anchor.querySelector(".session-user-name")?.focus({ preventScroll: true });
    }

    positionEditor() {
      if (!this.editor) return;
      const { node, anchor } = this.editor;
      const box = anchor.getBoundingClientRect();
      const bounds = this.list.getBoundingClientRect();
      if (!anchor.isConnected || !anchor.getClientRects().length || !bounds.width || !bounds.height
        || box.bottom < bounds.top || box.top > bounds.bottom) { if (!this.busy) this.closeEditor(); return; }
      const width = node.offsetWidth; const height = node.offsetHeight;
      node.style.left = `${Math.max(12, Math.min(innerWidth - width - 12, box.left))}px`;
      const below = innerHeight - box.bottom >= height + 20;
      node.style.top = `${Math.max(12, Math.min(innerHeight - height - 12, below ? box.bottom + 8 : box.top - height - 8))}px`;
    }

    beginDrag(badge) {
      const id = badge.dataset.userId;
      if (this.mode === "select" && !this.selected.has(id)) { this.selected.add(id); this.sync(); }
      const ids = this.mode === "select" ? this.entries.filter(user => this.selected.has(user.id)).map(user => user.id) : [id];
      this.drag = { ids, version: this.version, before: null, overList: false };
      for (const node of this.list.querySelectorAll(".session-user-badge")) node.classList.toggle("dragging", ids.includes(node.dataset.userId));
      this.stage.classList.add("is-dragging"); this.trash.disabled = false;
    }

    dragStart(event) {
      const badge = event.target.closest(".session-user-badge");
      if (!badge || this.busy || this.mode === "rename") { event.preventDefault(); return; }
      this.beginDrag(badge);
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", this.drag.ids.join(","));
      const dragImage = document.createElement("div");
      dragImage.className = "session-user-drag-image";
      dragImage.setAttribute("aria-hidden", "true");
      dragImage.dataset.editMode = this.mode;
      dragImage.style.setProperty("--session-user-row-height", getComputedStyle(this.stage).getPropertyValue("--session-user-row-height"));
      const clone = badge.cloneNode(true);
      clone.classList.remove("dragging"); clone.draggable = false;
      const box = badge.getBoundingClientRect();
      clone.style.width = `${box.width}px`;
      clone.style.height = `${box.height}px`;
      dragImage.append(clone);
      document.body.append(dragImage);
      // The 2px inset preserves the selected outline in the native snapshot.
      event.dataTransfer.setDragImage(dragImage, box.width / 2 + 2, box.height / 2 + 2);
      this.drag.image = dragImage;
    }

    dragOver(event) {
      if (!this.drag) return;
      event.preventDefault(); event.dataTransfer.dropEffect = "move"; this.chooseDrop(event.clientX, event.clientY);
    }

    chooseDrop(x, y) {
      if (!this.drag) return;
      this.clearIndicators();
      const candidates = [...this.list.querySelectorAll(".session-user-badge")].filter(node => !this.drag.ids.includes(node.dataset.userId));
      let closest = null; let distance = Infinity;
      for (const node of candidates) {
        const box = node.getBoundingClientRect();
        const candidate = (x - box.left - box.width / 2) ** 2 + (y - box.top - box.height / 2) ** 2;
        if (candidate < distance) { distance = candidate; closest = node; }
      }
      let before = closest;
      if (closest) {
        const box = closest.getBoundingClientRect();
        if (x >= box.left + box.width / 2) before = candidates[candidates.indexOf(closest) + 1] || null;
      }
      this.drag.before = before?.dataset.userId || null;
      this.drag.overList = true;
      if (before) before.classList.add("drop-before"); else candidates.at(-1)?.classList.add("drop-after");
    }

    drop(event) {
      if (!this.drag) return;
      event.preventDefault(); const drag = this.drag; this.finishDrag();
      if (drag.overList) void this.commit({ action: "reorder", user_ids: drag.ids, before_user_id: drag.before }, drag.version);
    }

    clearIndicators() {
      for (const node of this.list.querySelectorAll(".session-user-badge")) node.classList.remove("drop-before", "drop-after");
    }

    finishDrag() {
      this.drag?.image?.remove();
      this.drag = null; this.pointer = null;
      this.stage.classList.remove("is-dragging"); this.trash.classList.remove("drag-over");
      for (const node of this.list.querySelectorAll(".dragging")) node.classList.remove("dragging");
      this.clearIndicators(); this.sync();
    }

    pointerDown(event) {
      if (event.pointerType === "mouse" || this.busy || this.mode === "rename" || !event.target.closest(".session-user-order-number")) return;
      const badge = event.target.closest(".session-user-badge");
      this.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, badge };
      badge.setPointerCapture(event.pointerId);
    }

    pointerMove(event) {
      if (!this.pointer || this.pointer.id !== event.pointerId) return;
      if (!this.drag && Math.hypot(event.clientX - this.pointer.x, event.clientY - this.pointer.y) < 6) return;
      if (!this.drag) this.beginDrag(this.pointer.badge);
      event.preventDefault();
      this.pointer.overTrash = this.isOverTrash(event.clientX, event.clientY);
      this.trash.classList.toggle("drag-over", this.pointer.overTrash);
      const listBox = this.list.getBoundingClientRect();
      this.drag.overList = event.clientX >= listBox.left && event.clientX <= listBox.right && event.clientY >= listBox.top && event.clientY <= listBox.bottom;
      if (this.drag.overList) this.chooseDrop(event.clientX, event.clientY);
      else this.clearIndicators();
      if (event.clientY < listBox.top + 24) this.list.scrollTop -= 12;
      else if (event.clientY > listBox.bottom - 24) this.list.scrollTop += 12;
    }

    isOverTrash(x, y) {
      const box = this.trashSlot.getBoundingClientRect();
      return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
    }

    pointerUp(event) {
      if (!this.pointer || this.pointer.id !== event.pointerId) return;
      const drag = this.drag; const overTrash = this.pointer.overTrash;
      const id = this.pointer.badge.dataset.userId;
      this.finishDrag();
      if (!drag) return;
      this.suppressClick = { id, time: event.timeStamp };
      if (overTrash) void this.commit({ action: "remove", user_ids: drag.ids }, drag.version);
      else if (drag.overList) void this.commit({ action: "reorder", user_ids: drag.ids, before_user_id: drag.before }, drag.version);
    }

    moveSelection(direction) {
      if (!this.selected.size || this.busy) return;
      const selectedIndexes = this.entries.map((user, index) => this.selected.has(user.id) ? index : -1).filter(index => index >= 0);
      const edge = direction < 0 ? selectedIndexes[0] : selectedIndexes.at(-1);
      const index = edge + direction;
      if (index < 0 || index >= this.entries.length) return;
      const before = direction < 0 ? this.entries[index] : this.entries[index + 1];
      void this.commit({ action: "reorder", user_ids: [...this.selected], before_user_id: before?.id || null });
    }
  }

  global.BilikaraSessionUserEditor = SessionUserEditor;
})(window);
