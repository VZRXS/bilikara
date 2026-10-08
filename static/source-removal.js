/* Host local-source editor. Remote never mounts this controller. */
(function (root) {
  "use strict";
  const icon = path => '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  const trash = icon('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7"/>');
  class SourceEditor {
    constructor(grid, options) {
      this.grid = grid; this.options = options; this.source = options.source; this.t = options.translate;
      this.panel = grid.closest('.source-mode-panel');
      this.scroll = grid.closest('.source-browse-scroll');
      this.selected = new Set(); this.cards = new Map(); this.records = []; this.pageRecords = [];
      this.version = ""; this.filter = ""; this.editing = false; this.pending = false; this.active = false;
      this.footer = document.createElement('div'); this.footer.className = 'source-tools';
      this.footer.dataset.source = this.source; this.footer.hidden = true;
      this.footer.innerHTML = '<button type="button" class="toolbar-button settings-tool-button source-select-page" hidden></button>'
        + '<button type="button" class="toolbar-button settings-tool-button source-clear-selection" hidden></button>'
        + '<button type="button" class="toolbar-button settings-tool-button source-retry-cleanup" hidden></button>'
        + '<span class="source-selection-count" role="status" aria-live="polite"></span>'
        + '<button type="button" class="source-select-mode source-float-surface" aria-pressed="false">' + root.BilikaraSessionUserEditor.selectionIcon + '</button>'
        + '<span class="source-trash-slot"><span class="source-remove-selected source-float-surface" role="img">' + trash + '</span></span>';
      this.panel.append(this.footer);
      this.all = this.footer.querySelector('.source-select-page'); this.clear = this.footer.querySelector('.source-clear-selection');
      this.count = this.footer.querySelector('.source-selection-count'); this.toggle = this.footer.querySelector('.source-select-mode');
      this.remove = this.footer.querySelector('.source-remove-selected');
      this.trashSlot = this.remove.parentElement;
      for (const node of [this.all,this.clear,this.count,this.footer.querySelector('.source-retry-cleanup')]) node.classList.add('source-float-surface');
      this.footer.addEventListener('click', event => {
        if (event.target.closest('.source-select-mode')) {
          if (this.editing ? !this.pending : !this.blocked) this.setEditing(!this.editing);
          return;
        }
        if (this.blocked) return;
        if (event.target.closest('.source-select-page')) { for (const row of this.pageRecords) if (!row.placeholder) this.selected.add(row.id); this.paint(); }
        else if (event.target.closest('.source-clear-selection')) { this.selected.clear(); this.paint(); }
        else if (event.target.closest('.source-retry-cleanup') && this.cleanupIds?.length) void this.commit({action:'cleanup',ids:[...this.cleanupIds]});
      });
      grid.addEventListener('click', event => this.click(event), true);
      grid.addEventListener('change', event => {
        if (!event.target.matches('.source-checkbox')) return;
        const id = event.target.closest('.source-removal-card').dataset.sourceId;
        if (!this.blocked && this.editing) {
          if (event.target.checked) this.selected.add(id); else this.selected.delete(id);
        }
        this.paint();
      });
      grid.addEventListener('focusin', event => {
        const button = event.target.closest('.follow-up-button');
        if (!button?.closest('.source-removal-card') || this.blocked || this.editing) return;
        this.focusId = button.closest('.source-removal-card').dataset.sourceId; this.paint();
      });
      grid.addEventListener('pointerdown', event => this.pointerDown(event));
      grid.addEventListener('pointermove', event => this.pointerMove(event));
      grid.addEventListener('pointerup', event => this.pointerUp(event));
      grid.addEventListener('pointercancel', () => this.finishDrag());
      grid.addEventListener('lostpointercapture', () => this.finishDrag());
      grid.addEventListener('dragstart', event => { if (this.pointer) event.preventDefault(); });
      grid.addEventListener('contextmenu', event => {
        if (this.mobile && (this.hold || this.editing) && event.target.closest('.source-removal-card')) event.preventDefault();
      });
      this.scroll.addEventListener('scroll', () => { if (!this.hold?.triggered) this.cancelHold(); });
      root.addEventListener('pointerdown', event => {
        if (this.hold && event.pointerId !== this.hold.id) this.cancelHold();
        if (this.pointer && event.pointerId !== this.pointer.id) this.finishDrag();
      }, true);
      grid.addEventListener('keydown', event => {
        const button = event.target.closest('.follow-up-button');
        if (!button?.closest('.source-removal-card') || !event.altKey || !['ArrowUp','ArrowDown'].includes(event.key)) return;
        event.preventDefault(); this.focusId = button.closest('.source-removal-card').dataset.sourceId;
        void this.moveBy(event.key === 'ArrowUp' ? -1 : 1);
      });
      root.addEventListener('blur', () => this.finishDrag());
      root.addEventListener('resize', () => this.finishDrag());
      root.addEventListener('pagehide', () => this.finishDrag());
      document.addEventListener('visibilitychange', () => { if (document.hidden) this.finishDrag(); });
      this.pager = root.BilikaraResultPager.create(grid, {
        footer:this.panel, fit:this.scroll,
        ignoreSwipe:".follow-up-button, .source-select-target",
        translate:this.t, reportError:options.reportError,
        renderItems:(rows, message, target = grid) => {
          if (target !== grid) return options.renderPage(rows, message, target, null);
          const signature = rows.map(row => row.id).join(',');
          if (this.pageSignature !== signature) this.finishDrag();
          this.pageSignature = signature; this.pageRecords = rows;
          options.renderPage(rows, message, grid, this); this.paint();
        },
      });
    }
    get blocked() { return this.pending || this.loading || this.pullBusy || !this.available || !this.active; }
    get mobile() { return document.documentElement.dataset.hostPlatform === 'android'; }
    handleEscape() {
      if (!this.active || this.confirmation) return false;
      if (this.pointer || (this.hold && !this.hold.triggered)) this.finishDrag();
      else if (this.editing && !this.pending) { this.setEditing(false); this.toggle.focus({preventScroll:true}); }
      else return false;
      return true;
    }
    setEditing(value) {
      this.finishDrag(); this.editing = value; this.selected.clear(); this.focusId = "";
      this.cancelConfirmation(); this.paint();
    }
    leave() {
      this.active = false; this.setEditing(false); this.footer.hidden = true;
      this.pager.hide();
    }
    cancelConfirmation() {
      if (!this.confirmation) return;
      this.confirmation = null; this.options.closeConfirmation?.(this);
    }
    update({records, version, editable, count, loading, pullBusy, active, filter = "", language, emptyText}) {
      if (filter !== this.filter || !active) this.setEditing(false);
      this.filter = filter; this.active = active; this.loading = loading; this.pullBusy = pullBusy;
      const nextVersion = String(version || '');
      if (nextVersion !== this.version) {
        const interrupted = Boolean(this.pointer || this.hold || this.confirmation);
        this.finishDrag(); this.cancelConfirmation();
        if (interrupted) this.options.reportError(this.t('sources.changed'));
      }
      this.version = nextVersion;
      const ids = new Set(records.filter(row => !row.placeholder).map(row => row.id));
      this.available = editable === true && count === ids.size && /^[a-f0-9]{64}$/u.test(this.version);
      for (const id of this.selected) if (!ids.has(id)) this.selected.delete(id);
      if (!ids.has(this.focusId)) this.focusId = "";
      for (const [id, card] of this.cards) if (!ids.has(id)) { card.remove(); this.cards.delete(id); }
      const previous = new Map(this.records.map(row => [row.id,row]));
      const sameIds = records.map(row => row.id).join(',') === this.records.map(row => row.id).join(',');
      const rows = records.map(row => Object.assign(previous.get(row.id) || {}, row));
      if (sameIds) this.records.splice(0,this.records.length,...rows); else this.records = rows;
      this.pager.update({key:this.source + ':' + filter,items:this.records,total:records.length,pageSize:12,
        limited:true,hasMore:false,loading:loading || this.pending,language,emptyText});
      if (!active) this.pager.hide();
      // Count/status-only updates retain the page and card nodes during a drag.
      this.options.renderPage(this.pageRecords, emptyText, this.grid, this); this.paint();
    }
    card(button, {id, title, placeholder = false}) {
      if (placeholder) return button;
      let card = this.cards.get(id);
      if (!card) {
        card = document.createElement('div'); card.className = 'source-removal-card'; card.dataset.sourceId = id;
        card.setAttribute('role','listitem');
        const target = document.createElement('label'); target.className = 'source-select-target'; target.hidden = true;
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'source-checkbox';
        target.append(checkbox); card.append(button,target); this.cards.set(id, card);
      } else {
        const current = card.querySelector('.follow-up-button');
        // Preserve pointer capture and ordinary card focus.
        current.dataset.uid = button.dataset.uid || ''; current.dataset.folderId = button.dataset.folderId || '';
        current.title = button.title; current.className = button.className;
        if (current.dataset.contentSignature !== button.dataset.contentSignature) {
          current.replaceChildren(...button.childNodes);
          current.dataset.contentSignature = button.dataset.contentSignature;
        }
        for (const key of ['aria-busy']) { if (button.hasAttribute(key)) current.setAttribute(key,button.getAttribute(key)); else current.removeAttribute(key); }
      }
      card.dataset.sourceTitle = title; return card;
    }
    paint() {
      if (!this.footer) return;
      this.footer.classList.toggle('is-touch',this.mobile);
      this.footer.toggleAttribute('aria-busy', this.pending);
      if (this.pending) this.footer.setAttribute('aria-busy','true');
      for (const button of this.footer.querySelectorAll('button')) {
        if (this.pending) button.setAttribute('aria-busy','true'); else button.removeAttribute('aria-busy');
      }
      this.toggle.setAttribute('aria-label',this.t(this.editing ? 'sources.doneSelecting' : 'sources.selectMode'));
      this.toggle.title = this.toggle.getAttribute('aria-label');
      this.toggle.setAttribute('aria-pressed',String(this.editing));
      this.toggle.disabled = this.editing ? this.pending : this.blocked;
      this.toggle.hidden = this.mobile && !this.editing;
      this.all.hidden = this.clear.hidden = !this.editing || this.mobile;
      this.all.textContent = this.t('sources.selectPage'); this.clear.textContent = this.t('sources.clearSelection');
      this.all.disabled = this.blocked || !this.pageRecords.some(row => !row.placeholder);
      this.clear.disabled = this.blocked || !this.selected.size;
      const cleanup = this.footer.querySelector('.source-retry-cleanup');
      cleanup.hidden = !this.cleanupIds?.length; cleanup.disabled = this.blocked; cleanup.textContent = this.t('sources.retryCleanup');
      this.remove.setAttribute('aria-label',this.t(this.pending ? 'sources.removing' : 'sources.dragToRemove'));
      if (this.pending) this.remove.setAttribute('aria-busy','true'); else this.remove.removeAttribute('aria-busy');
      this.trashSlot.hidden = !this.editing;
      const members = this.records.filter(row => !row.placeholder), index = members.findIndex(row => row.id === this.focusId);
      this.count.textContent = this.editing ? this.t('sources.selectedTotal',{count:this.selected.size})
        : !this.mobile && this.focusId ? this.t('sources.orderTarget',{name:members[index]?.title || ''}) : '';
      if (!this.available && this.active && !this.loading) this.count.textContent = this.t('sources.orderUnavailable');
      else if (this.pullBusy && this.active) this.count.textContent = this.t('sources.editBusy');
      else if (this.selected.size > 128) this.count.textContent = this.t('sources.batchLimit',{count:this.selected.size});
      this.count.hidden = !this.count.textContent;
      this.footer.hidden = !this.active || (this.mobile && !this.editing && !this.cleanupIds?.length && !this.count.textContent);
      const overlay = !this.footer.hidden;
      // The floating tools never obscure pagination. Add only temporary scroll
      // reach when they cover a card; neither a tool row nor a smaller viewport.
      const tools = this.footer.getBoundingClientRect();
      this.panel.classList.toggle('source-tools-scroll-reach',overlay && this.editing
        && [...this.grid.children].some(card => {
          const box = card.getBoundingClientRect();
          // Assess the unscrolled content so reaching the bottom cannot remove
          // its own reach and repeatedly clamp/reopen the scrollbar.
          return box.right > tools.left && box.left < tools.right
            && box.bottom + this.scroll.scrollTop > tools.top - 8;
        }));
      this.panel.classList.toggle('source-page-fits',this.active && Boolean(this.grid.getClientRects().length)
        && this.grid.getBoundingClientRect().height <= this.scroll.clientHeight + 1);
      this.panel.classList.toggle('has-source-tools-overlay',overlay);
      for (const card of this.cards.values()) {
        const id = card.dataset.sourceId, button = card.querySelector('.follow-up-button');
        const target = card.querySelector('.source-select-target'), checkbox = target.querySelector('input');
        button.disabled = this.pending;
        target.hidden = !this.editing; checkbox.checked = this.selected.has(id); checkbox.disabled = this.blocked;
        checkbox.setAttribute('aria-label',this.t('sources.selectSource',{name:card.dataset.sourceTitle}));
        checkbox.setAttribute('aria-description',this.t('sources.dragToRemove'));
        if (this.editing) button.setAttribute('aria-pressed',String(this.selected.has(id)));
        else button.removeAttribute('aria-pressed');
        button.setAttribute('aria-keyshortcuts','Alt+ArrowUp Alt+ArrowDown');
        button.setAttribute('aria-description',this.t(this.mobile ? 'sources.longPressToSelect' : 'sources.orderCard'));
        card.classList.toggle('is-draggable',!this.blocked && !this.editing);
        card.classList.toggle('is-selecting',this.editing);
        card.classList.toggle('is-selected',this.selected.has(id)); card.classList.toggle('is-order-target',this.focusId === id);
      }
    }
    click(event) {
      const card = event.target.closest('.source-removal-card'); if (!card) return;
      const id = card.dataset.sourceId;
      if (this.suppressClick && event.timeStamp - this.suppressClick.time < 500 && id === this.suppressClick.id) {
        event.preventDefault(); event.stopImmediatePropagation(); this.suppressClick = null; return;
      }
      if (this.pending || (this.editing && this.blocked)) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      if (this.editing) {
        // Native label activation/change owns checkbox clicks and Space.
        if (event.target.closest('.source-select-target')) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (this.selected.has(id)) this.selected.delete(id); else this.selected.add(id); this.paint();
      }
    }
    askRemoval(ids = [...this.selected]) {
      if (this.blocked || !ids.length || ids.length > 128) return;
      const selected = new Set(ids), records = this.records.filter(row => !row.placeholder && selected.has(row.id));
      if (records.length !== ids.length) return;
      const captured = {ids:records.map(row => row.id),version:this.version,filter:this.filter};
      this.confirmation = captured;
      this.options.confirm(this,captured,this.t('sources.removeBatchConfirm',{count:captured.ids.length,
        type:this.t(this.source === 'uid' ? 'sources.ownerList' : 'sources.favorites')}),
        records.slice(0,3).map(row => row.title.slice(0,80)).join('、'));
    }
    async confirmRemoval(captured) {
      if (this.confirmation !== captured || this.blocked) return;
      this.confirmation = null;
      if (captured.version !== this.version || captured.filter !== this.filter) { this.options.reportError(this.t('sources.changed')); return; }
      await this.commit({action:'remove',ids:captured.ids},captured.version);
    }
    async commit(edit, version = this.version) {
      if (this.blocked) return;
      this.pending = true; this.finishDrag(); this.paint();
      const focusId = edit.id;
      try {
        const result = await this.options.post({source:this.source,expected_version:version,edit});
        if (result.committed) for (const id of result.removed_ids || []) this.selected.delete(id);
        if (result.cleanup_pending?.length) this.cleanupIds = edit.ids;
        else if (edit.action === 'cleanup') this.cleanupIds = null;
        this.options.message(this.t(result.cleanup_pending?.length ? 'sources.removedCleanupPending'
          : edit.action === 'remove' ? 'sources.removedLocal' : edit.action === 'cleanup' ? 'sources.cleanupDone' : 'sources.orderSaved'),Boolean(result.cleanup_pending?.length));
      } catch (error) { this.options.reportError(error.message || this.t('sources.changed')); }
      finally {
        await this.options.reload().catch(error => this.options.reportError(error.message));
        this.pending = false; this.options.refresh?.(); this.paint();
        if (focusId && this.active) this.cards.get(focusId)?.querySelector('.follow-up-button')?.focus({preventScroll:true});
      }
    }
    moveBy(direction) {
      if (this.blocked || this.editing) return;
      const members = this.records.filter(row => !row.placeholder), index = members.findIndex(row => row.id === this.focusId);
      if (index < 0 || index + direction < 0 || index + direction >= members.length) return;
      const anchor = direction < 0 ? members[index-1] : members[index+2];
      return this.commit({action:'move',id:this.focusId,before_id:anchor?.id || null});
    }
    pointerDown(event) {
      // Suppress only the release click of a retired drag, never a deliberate
      // new press on that card after canceling its confirmation.
      if (event.target.closest('.source-removal-card') && event.isPrimary !== false && event.button === 0) this.suppressClick = null;
      const selectionTarget = event.target.closest('.source-select-target');
      if (this.editing && selectionTarget && !this.blocked && event.isPrimary !== false && event.button === 0) {
        this.finishDrag(); this.suppressClick = null;
        this.pointer = {kind:'remove',id:event.pointerId,sourceId:selectionTarget.closest('.source-removal-card').dataset.sourceId,
          target:selectionTarget,x:event.clientX,y:event.clientY,version:this.version,filter:this.filter};
        selectionTarget.setPointerCapture(event.pointerId);
        return;
      }
      const target = event.target.closest('.follow-up-button');
      if (!target || !target.closest('.source-removal-card')
        || this.blocked || this.editing || event.isPrimary === false || event.button !== 0) return;
      if (event.pointerType !== 'mouse' && !(event.pointerType === 'touch' && this.mobile)) return;
      this.finishDrag(); this.suppressClick = null;
      const id = target.closest('.source-removal-card').dataset.sourceId;
      if (event.pointerType === 'touch') {
        const hold = {id:event.pointerId,sourceId:id,x:event.clientX,y:event.clientY,version:this.version,target};
        this.hold = hold;
        hold.timer = root.setTimeout(() => {
          if (this.hold !== hold) return;
          if (this.blocked || hold.version !== this.version || !target.isConnected
            || !this.pageRecords.some(row => row.id === id && !row.placeholder)) { this.cancelHold(); return; }
          this.hold = null; hold.timer = null;
          this.setEditing(true); this.selected.add(id);
          hold.triggered = true; this.hold = hold; this.paint();
        },450);
        return;
      }
      this.focusId = id; this.pointer = {id:event.pointerId,sourceId:id,target,x:event.clientX,y:event.clientY,version:this.version};
      target.setPointerCapture(event.pointerId); this.paint();
    }
    pointerMove(event) {
      const hold = this.hold;
      if (hold?.id === event.pointerId) {
        if (!hold.triggered && Math.hypot(event.clientX-hold.x,event.clientY-hold.y) > 8) this.cancelHold();
        return;
      }
      const pointer = this.pointer; if (!pointer || pointer.id !== event.pointerId) return;
      if (!pointer.dragging && Math.hypot(event.clientX-pointer.x,event.clientY-pointer.y) < 6) return;
      if (pointer.kind === 'remove') {
        if (this.blocked || pointer.version !== this.version || pointer.filter !== this.filter) { this.finishDrag(); return; }
        if (!pointer.dragging) {
          this.selected.add(pointer.sourceId);
          pointer.ids = this.records.filter(row => !row.placeholder && this.selected.has(row.id)).map(row => row.id);
          pointer.dragging = true; this.paint();
          for (const id of pointer.ids) this.cards.get(id)?.classList.add('is-dragging');
        }
        event.preventDefault();
        const box = this.trashSlot.getBoundingClientRect();
        pointer.overTrash = !this.trashSlot.hidden && pointer.ids.length <= 128
          && event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
        this.remove.classList.toggle('drag-over',pointer.overTrash);
        return;
      }
      pointer.dragging = true; event.preventDefault();
      this.cards.get(pointer.sourceId)?.classList.add('is-dragging');
      const bounds = this.grid.getBoundingClientRect(), scroll = this.scroll.getBoundingClientRect();
      pointer.valid = event.clientX >= bounds.left && event.clientX <= bounds.right
        && event.clientY >= Math.max(bounds.top,scroll.top) && event.clientY <= Math.min(bounds.bottom,scroll.bottom);
      this.clearIndicators(); if (!pointer.valid) return;
      let closest = null, distance = Infinity;
      for (const card of this.grid.querySelectorAll('.source-removal-card')) {
        if (card.dataset.sourceId === pointer.sourceId) continue;
        const box = card.getBoundingClientRect(), value = (event.clientX-box.left-box.width/2)**2 + (event.clientY-box.top-box.height/2)**2;
        if (value < distance) { closest = card; distance = value; }
      }
      if (!closest) { pointer.valid = false; return; }
      const box = closest.getBoundingClientRect(), before = event.clientX < box.left+box.width/2;
      const members = this.records.filter(row => !row.placeholder && row.id !== pointer.sourceId);
      const index = members.findIndex(row => row.id === closest.dataset.sourceId);
      pointer.before = before ? closest.dataset.sourceId : members[index+1]?.id || null;
      closest.classList.add(before ? 'drop-before' : 'drop-after');
      if (event.clientY < scroll.top+24) this.scroll.scrollTop -= 12;
      else if (event.clientY > scroll.bottom-24) this.scroll.scrollTop += 12;
    }
    pointerUp(event) {
      if (this.hold?.id === event.pointerId) {
        const hold = this.hold; this.cancelHold();
        if (hold.triggered) { this.suppressClick = {id:hold.sourceId,time:event.timeStamp}; event.preventDefault(); }
        return;
      }
      const pointer = this.pointer; if (!pointer || pointer.id !== event.pointerId) return;
      if (pointer.kind === 'remove') {
        const valid = pointer.dragging && pointer.overTrash && pointer.version === this.version && pointer.filter === this.filter && !this.blocked;
        this.finishDrag();
        if (pointer.dragging) {
          this.suppressClick = {id:pointer.sourceId,time:event.timeStamp}; event.preventDefault();
          if (valid) this.askRemoval(pointer.ids);
        }
        return;
      }
      const members = this.records.filter(row => !row.placeholder), index = members.findIndex(row => row.id === pointer.sourceId);
      const unchanged = pointer.before === (members[index+1]?.id || null) || pointer.before === pointer.sourceId;
      this.finishDrag();
      if (!pointer.dragging) return;
      this.suppressClick = {id:pointer.sourceId,time:event.timeStamp}; event.preventDefault();
      if (pointer.valid && pointer.version === this.version && !unchanged) void this.commit({action:'move',id:pointer.sourceId,before_id:pointer.before},pointer.version);
    }
    clearIndicators() { for (const card of this.cards.values()) card.classList.remove('drop-before','drop-after'); }
    cancelHold() {
      const hold = this.hold; this.hold = null;
      if (!hold) return;
      root.clearTimeout(hold.timer);
      if (hold.triggered) this.suppressClick = {id:hold.sourceId,time:performance.now()};
    }
    finishDrag() {
      this.cancelHold();
      const pointer = this.pointer; this.pointer = null;
      // Canceling capture can still produce a card click on mouse release.
      if (pointer?.dragging) this.suppressClick = {id:pointer.sourceId,time:performance.now()};
      if (pointer?.target.hasPointerCapture(pointer.id)) pointer.target.releasePointerCapture(pointer.id);
      for (const card of this.cards?.values() || []) card.classList.remove('is-dragging');
      this.remove.classList.remove('drag-over');
      this.clearIndicators();
    }
  }
  root.BilikaraSourceRemoval = Object.freeze({create:(grid,options) => grid ? new SourceEditor(grid,options) : null});
})(window);
