/* Host local-source editor. Remote never mounts this controller. */
(function (root) {
  "use strict";
  function dropPosition(rows, rowIndex, x, y) {
    if (!rows[rowIndex]) rowIndex = 0;
    const row = rows[rowIndex] || rows[0];
    if (!row) return null;
    const above = rows[rowIndex - 1], below = rows[rowIndex + 1];
    // Cross well into the next row, rather than switching at the gap midpoint.
    if ((above && y <= above.bottom - Math.min(16, (above.bottom-above.top)*.2))
      || (below && y >= below.top + Math.min(16, (below.bottom-below.top)*.2))) {
      rowIndex = rows.reduce((best, candidate, index) => Math.abs(y-(candidate.top+candidate.bottom)/2)
        < Math.abs(y-(rows[best].top+rows[best].bottom)/2) ? index : best, 0);
    }
    const cards = rows[rowIndex].cards;
    const card = cards.reduce((best, candidate) => Math.abs(x-(candidate.left+candidate.right)/2)
      < Math.abs(x-(best.left+best.right)/2) ? candidate : best);
    return {rowIndex, card, before:x < (card.left+card.right)/2};
  }
  class SourceEditor {
    constructor(grid, options) {
      this.grid = grid; this.options = options; this.source = options.source; this.t = options.translate;
      this.panel = grid.closest('.source-mode-panel');
      this.scroll = grid.closest('.source-browse-scroll');
      this.selected = new Set(); this.cards = new Map(); this.records = []; this.pageRecords = [];
      this.version = ""; this.filter = ""; this.editing = false; this.pending = false; this.active = false;
      this.footer = document.createElement('div'); this.footer.className = 'source-tools';
      this.footer.dataset.source = this.source; this.footer.hidden = true;
      this.frame = document.createElement('div'); this.frame.className = 'source-frame-footer'; this.frame.hidden = true;
      this.footer.innerHTML = '<button type="button" class="toolbar-button settings-tool-button source-select-page" hidden></button>'
        + '<button type="button" class="toolbar-button settings-tool-button source-retry-cleanup" hidden></button>'
        + '<span class="source-selection-count" role="status" aria-live="polite"></span>'
        + '<button type="button" class="source-select-mode" aria-pressed="false">' + root.BilikaraSessionUserEditor.selectionIcon + '</button>'
        + '<span class="source-trash-slot"><span class="source-remove-selected" role="img">' + root.BilikaraSessionUserEditor.trashIcon + '</span></span>';
      this.frame.append(this.footer); this.panel.append(this.frame);
      this.all = this.footer.querySelector('.source-select-page');
      this.count = this.footer.querySelector('.source-selection-count'); this.toggle = this.footer.querySelector('.source-select-mode');
      this.remove = this.footer.querySelector('.source-remove-selected');
      this.trashSlot = this.remove.parentElement;
      this.trashSlot.tabIndex = 0;
      this.help = new Map([...this.footer.querySelectorAll('button'), this.remove].map((button, index) => [button,
        root.BilikaraSessionUserEditor.toolHelp(button, `source-${this.source}-tool-help-${index}`,
          options.bindHelp, button === this.remove ? this.trashSlot : null)]));
      this.footer.setAttribute('role','group');
      this.footer.addEventListener('click', event => {
        const mode = event.target.closest('.source-select-mode');
        if (mode) {
          if (event.detail !== 0 && this.toolRelease?.target === mode && event.timeStamp-this.toolRelease.time < 500) {
            event.preventDefault(); event.stopImmediatePropagation(); this.toolRelease = null; return;
          }
          this.activateMode(mode); return;
        }
        if (this.blocked) return;
        if (event.target.closest('.source-select-page')) {
          const members=this.pageRecords.filter(row=>!row.placeholder);
          if (members.every(row=>this.selected.has(row.id))) this.selected.clear();
          else for (const row of members) this.selected.add(row.id);
          this.paint();
        }
        else if (event.target.closest('.source-retry-cleanup') && this.cleanupIds?.length) void this.commit({action:'cleanup',ids:[...this.cleanupIds]});
      });
      // Some touch browsers omit the compatibility click after a captured
      // card drag. Activate these immediate mode actions on a stationary
      // release, and reject any subsequent compatibility click of that press.
      this.footer.addEventListener('pointerdown', event => {
        this.toolRelease = null; this.toolPointer = null;
        const target = event.target.closest('.source-select-mode');
        if (event.pointerType === 'touch' && event.isPrimary !== false && event.button === 0 && target && !target.disabled) {
          this.toolPointer = {id:event.pointerId,target,x:event.clientX,y:event.clientY,version:this.version,filter:this.filter};
        }
      });
      this.footer.addEventListener('pointermove', event => {
        const press = this.toolPointer;
        if (press?.id === event.pointerId && Math.hypot(event.clientX-press.x,event.clientY-press.y)>8) press.cancelled = true;
      });
      this.footer.addEventListener('pointercancel', () => { this.toolPointer = null; });
      this.footer.addEventListener('pointerup', event => {
        const press = this.toolPointer; this.toolPointer = null;
        if (press?.id === event.pointerId && press.cancelled) {
          this.toolRelease = {target:press.target,time:event.timeStamp}; event.preventDefault(); return;
        }
        if (press?.id !== event.pointerId || !this.active || press.version !== this.version || press.filter !== this.filter
          || event.target.closest('button') !== press.target || Math.hypot(event.clientX-press.x,event.clientY-press.y)>8) return;
        if (this.activateMode(press.target)) {
          this.toolRelease = {target:press.target,time:event.timeStamp}; event.preventDefault();
        }
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
      // Keep native vertical scrolling until a long press claims the drag.
      // Once claimed, prevent the browser from cancelling that pointer stream.
      grid.addEventListener('touchmove', event => {
        if (this.pointer && event.cancelable) event.preventDefault();
      }, {passive:false});
      grid.addEventListener('pointerup', event => this.pointerUp(event));
      grid.addEventListener('pointercancel', () => this.finishDrag());
      grid.addEventListener('lostpointercapture', () => this.finishDrag());
      grid.addEventListener('dragstart', event => { if (this.pointer) event.preventDefault(); });
      grid.addEventListener('contextmenu', event => {
        if (this.mobile && (this.hold || this.editing) && event.target.closest('.source-removal-card')) event.preventDefault();
      });
      this.scroll.addEventListener('scroll', () => { if (!this.hold?.triggered) this.cancelHold(); });
      root.addEventListener('pointerdown', event => {
        if (this.toolPointer && event.pointerId !== this.toolPointer.id) this.toolPointer = null;
        if (this.hold && event.pointerId !== this.hold.id) this.cancelHold();
        if (this.pointer && event.pointerId !== this.pointer.id) this.finishDrag();
      }, true);
      root.addEventListener('blur', () => this.finishDrag());
      root.addEventListener('resize', () => this.finishDrag());
      root.addEventListener('pagehide', () => this.finishDrag());
      document.addEventListener('visibilitychange', () => { if (document.hidden) this.finishDrag(); });
      this.pager = this.mobile ? root.BilikaraResultPager.create(grid, {
        footer:this.frame, fit:this.scroll,
        ignoreSwipe:target => Boolean(this.pointer || this.hold?.triggered || target.closest(".source-select-target")),
        translate:this.t, reportError:options.reportError,
        renderItems:(rows, message, target = grid) => {
          if (target !== grid) {
            const cards = new Map();
            options.renderPage(rows, message, target, {card:(button, record) => this.card(button, record, cards)});
            for (const card of cards.values()) this.paintCard(card);
            return;
          }
          const signature = rows.map(row => row.id).join(',');
          if (this.pageSignature !== signature) this.finishDrag();
          this.pageSignature = signature; this.pageRecords = rows;
          options.renderPage(rows, message, grid, this); this.paint();
        },
      }) : null;
    }
    get blocked() { return this.pending || this.loading || !this.available || !this.active; }
    get interacting() { return Boolean(this.pointer || this.hold); }
    get mobile() { return document.documentElement.dataset.hostPlatform === 'android'; }
    activateMode(button) {
      if (button !== this.toggle || (this.editing ? this.pending : this.blocked)) return false;
      this.setEditing(!this.editing); return true;
    }
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
      this.active = false; this.setEditing(false); this.footer.hidden = true; this.frame.hidden = true;
      this.pager?.hide();
    }
    cancelConfirmation() {
      if (!this.confirmation) return;
      this.confirmation = null; this.options.closeConfirmation?.(this);
    }
    update({records, version, editable, editRevision, count, loading, active, filter = "", language, emptyText}) {
      if (filter !== this.filter || !active) this.setEditing(false);
      this.filter = filter; this.active = active; this.loading = loading;
      const nextVersion = String(version || '');
      // Background pull completions may wait for release, but an authoritative
      // edit revision must retire a captured gesture before its list reload.
      const edited = Number.isSafeInteger(editRevision) && this.editRevision !== undefined && editRevision !== this.editRevision;
      if (nextVersion !== this.version || edited) {
        const interrupted = Boolean(this.pointer || this.hold || this.confirmation);
        this.finishDrag(); this.cancelConfirmation();
        if (interrupted) this.options.reportError(this.t('sources.changed'));
      }
      this.version = nextVersion;
      if (Number.isSafeInteger(editRevision)) this.editRevision = editRevision;
      const ids = new Set(records.filter(row => !row.placeholder).map(row => row.id));
      this.available = editable === true && count === ids.size && /^[a-f0-9]{64}$/u.test(this.version);
      for (const id of this.selected) if (!ids.has(id)) this.selected.delete(id);
      if (!ids.has(this.focusId)) this.focusId = "";
      for (const [id, card] of this.cards) if (!ids.has(id)) { card.remove(); this.cards.delete(id); }
      const previous = new Map(this.records.map(row => [row.id,row]));
      const sameIds = records.map(row => row.id).join(',') === this.records.map(row => row.id).join(',');
      const rows = records.map(row => Object.assign(previous.get(row.id) || {}, row));
      if (sameIds) this.records.splice(0,this.records.length,...rows); else this.records = rows;
      if (this.pager) {
        this.pager.update({key:this.source + ':' + filter,items:this.records,total:records.length,pageSize:12,
          limited:true,hasMore:false,loading:loading || this.pending,language,emptyText});
        if (!active) this.pager.hide();
      } else this.pageRecords = this.records;
      // Count/status-only updates retain the page and card nodes during a drag.
      this.options.renderPage(this.pageRecords, emptyText, this.grid, this); this.paint();
    }
    card(button, {id, title, placeholder = false}, cards = this.cards) {
      if (placeholder) return button;
      let card = cards.get(id);
      if (!card) {
        card = document.createElement('div'); card.className = 'source-removal-card'; card.dataset.sourceId = id;
        card.setAttribute('role','listitem');
        const target = document.createElement('label'); target.className = 'source-select-target'; target.hidden = true;
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'source-checkbox';
        target.append(checkbox); card.append(button,target); cards.set(id, card);
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
      this.all.hidden = !this.editing;
      const selectable=this.pageRecords.filter(row=>!row.placeholder);
      const pageSelected=selectable.length > 0 && selectable.every(row=>this.selected.has(row.id));
      this.all.textContent = this.t(pageSelected ? 'session.clearSelection' : this.mobile ? 'sources.selectPage' : 'session.selectAll');
      this.all.disabled = this.blocked || !this.pageRecords.some(row => !row.placeholder);
      const cleanup = this.footer.querySelector('.source-retry-cleanup');
      cleanup.hidden = !this.cleanupIds?.length; cleanup.disabled = this.blocked; cleanup.textContent = this.t('sources.retryCleanup');
      this.remove.setAttribute('aria-label',this.t(this.pending ? 'sources.removing' : 'sources.dragToRemove'));
      if (this.pending) this.remove.setAttribute('aria-busy','true'); else this.remove.removeAttribute('aria-busy');
      this.remove.setAttribute('aria-disabled',String(this.blocked || !this.selected.size || this.selected.size > 128));
      this.count.textContent = this.editing ? this.t('sources.selectedTotal',{count:this.selected.size}) : '';
      if (this.editing && !this.available && this.active && !this.loading) this.count.textContent = this.t('sources.orderUnavailable');
      else if (this.selected.size > 128) this.count.textContent = this.t('sources.batchLimit',{count:this.selected.size});
      this.count.hidden = !this.count.textContent;
      this.footer.setAttribute('aria-label',this.t('sources.selectMode'));
      this.footer.hidden = !this.active;
      this.frame.hidden = !this.active;
      for (const [button, syncHelp] of this.help) syncHelp(button === this.toggle && !this.editing
        ? `${this.t('sources.selectMode')} · ${this.t(this.mobile ? 'sources.holdToReorder' : 'sources.orderCard')}`
        : button.getAttribute('aria-label') || button.textContent);
      for (const card of this.cards.values()) {
        this.paintCard(card);
      }
    }
    paintCard(card) {
      const id = card.dataset.sourceId, button = card.querySelector('.follow-up-button');
      const target = card.querySelector('.source-select-target'), checkbox = target.querySelector('input');
      button.disabled = this.pending;
      target.hidden = !this.editing; checkbox.checked = this.selected.has(id); checkbox.disabled = this.blocked;
      checkbox.setAttribute('aria-label',this.t('sources.selectSource',{name:card.dataset.sourceTitle}));
      checkbox.setAttribute('aria-description',this.t('sources.selectMode'));
      if (this.editing) button.setAttribute('aria-pressed',String(this.selected.has(id)));
      else button.removeAttribute('aria-pressed');
      button.setAttribute('aria-description',this.t(this.editing ? (this.mobile ? 'sources.holdToReorder' : 'sources.orderCard') : this.mobile ? 'sources.longPressToSelect' : 'sources.browseCard'));
      card.classList.toggle('is-draggable',!this.blocked && this.editing);
      card.classList.toggle('is-selecting',this.editing);
      card.classList.toggle('is-selected',this.selected.has(id));
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
      const names = records.slice(0,3).map(row => row.title.slice(0,80)).join('、') + (records.length > 3 ? '…' : '');
      this.options.confirm(this,captured,this.t(this.source === 'uid' ? 'sources.removeOwnersConfirm' : 'sources.removeFavoritesConfirm',
        {count:captured.ids.length,names}) + '\n' + this.t('sources.removeScope'));
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
        this.pending = false; this.options.refresh?.(); this.paint(); this.options.onIdle?.();
        if (focusId && this.active) this.cards.get(focusId)?.querySelector('.follow-up-button')?.focus({preventScroll:true});
      }
    }
    pointerDown(event) {
      // Suppress only the release click of a retired drag, never a deliberate
      // new press on that card after canceling its confirmation.
      if (event.target.closest('.source-removal-card') && event.isPrimary !== false && event.button === 0) this.suppressClick = null;
      const selectionTarget = event.target.closest('.source-select-target');
      // Checkbox/label presses only select. The remaining card owns dragging.
      if (selectionTarget) return;
      const target = event.target.closest('.follow-up-button');
      if (!target || !target.closest('.source-removal-card')
        || this.blocked || event.isPrimary === false || event.button !== 0) return;
      if (event.pointerType !== 'mouse' && !this.editing && !(event.pointerType === 'touch' && this.mobile)) return;
      this.finishDrag(); this.suppressClick = null;
      const id = target.closest('.source-removal-card').dataset.sourceId;
      if (this.editing && !(this.mobile && event.pointerType === 'touch')) {
        this.focusId = id;
        this.pointer = {kind:'move',id:event.pointerId,sourceId:id,x:event.clientX,y:event.clientY,version:this.version,filter:this.filter,target};
        target.setPointerCapture(event.pointerId); this.paint();
        return;
      }
      if (event.pointerType === 'touch') {
        const hold = {id:event.pointerId,sourceId:id,x:event.clientX,y:event.clientY,version:this.version,target};
        this.hold = hold;
        hold.timer = root.setTimeout(() => {
          if (this.hold !== hold) return;
          if (this.blocked || hold.version !== this.version || !target.isConnected
            || !this.pageRecords.some(row => row.id === id && !row.placeholder)) { this.cancelHold(); return; }
          this.hold = null; hold.timer = null;
          if (this.editing) {
            this.focusId = id;
            this.pointer = {kind:'move',id:event.pointerId,sourceId:id,x:hold.x,y:hold.y,version:this.version,filter:this.filter,target};
            target.setPointerCapture(event.pointerId);
            return;
          }
          this.setEditing(true); this.selected.add(id);
          hold.triggered = true; this.hold = hold; this.paint();
        },450);
        return;
      }

    }
    pointerMove(event) {
      const hold = this.hold;
      if (hold?.id === event.pointerId) {
        if (!hold.triggered && Math.hypot(event.clientX-hold.x,event.clientY-hold.y) > 8) this.cancelHold();
        return;
      }
      const pointer = this.pointer; if (!pointer || pointer.id !== event.pointerId) return;
      if (!pointer.dragging && Math.hypot(event.clientX-pointer.x,event.clientY-pointer.y) < 6) return;
      if (this.blocked || pointer.version !== this.version || pointer.filter !== this.filter) { this.finishDrag(); return; }
      if (!pointer.dragging) {
        this.selected.add(pointer.sourceId);
        pointer.ids = this.records.filter(row => !row.placeholder && this.selected.has(row.id)).map(row => row.id);
        pointer.dragging = true;
        if (pointer.ids.length > 128) { this.finishDrag(); this.options.reportError(this.t('sources.batchLimit',{count:pointer.ids.length})); return; }
        this.paint();
        for (const id of pointer.ids) this.cards.get(id)?.classList.add('is-dragging');
        const preview = this.cards.get(pointer.sourceId).cloneNode(true);
        for (const node of [preview,...preview.querySelectorAll('*')]) node.removeAttribute('id');
        preview.classList.remove('is-dragging'); preview.classList.add('source-drag-preview');
        preview.setAttribute('aria-hidden','true'); preview.inert = true;
        const bounds = pointer.target.getBoundingClientRect();
        preview.style.width = bounds.width+'px'; preview.style.height = bounds.height+'px';
        document.body.append(preview); pointer.preview = preview;
      }
      event.preventDefault();
      pointer.preview.style.left = (event.clientX-24)+'px'; pointer.preview.style.top = (event.clientY-24)+'px';
      const box = this.trashSlot.getBoundingClientRect();
      pointer.overTrash = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
      this.remove.classList.toggle('drag-over',pointer.overTrash);
      const bounds = this.grid.getBoundingClientRect(), scroll = this.scroll.getBoundingClientRect();
      pointer.valid = event.clientX >= bounds.left && event.clientX <= bounds.right
        && event.clientY >= Math.max(bounds.top,scroll.top) && event.clientY <= Math.min(bounds.bottom,scroll.bottom);
      this.clearIndicators(); if (!pointer.valid) return;
      if (!pointer.rows) {
        pointer.rows = [];
        for (const card of this.grid.querySelectorAll('.source-removal-card')) {
          const box = card.getBoundingClientRect(), top = box.top + this.scroll.scrollTop, bottom = box.bottom + this.scroll.scrollTop;
          let row = pointer.rows.at(-1);
          if (!row || Math.abs(row.top-top)>4) { row={top,bottom,cards:[]};pointer.rows.push(row); }
          row.cards.push({node:card,left:box.left,right:box.right});
          if (card.dataset.sourceId === pointer.sourceId) pointer.rowIndex = pointer.rows.length-1;
        }
      }
      const position = dropPosition(pointer.rows,pointer.rowIndex,event.clientX,event.clientY+this.scroll.scrollTop);
      if (!position) { pointer.valid = false; return; }
      pointer.rowIndex = position.rowIndex;
      const closest = position.card.node, before = position.before;
      const row = pointer.rows[position.rowIndex].cards, slot = row.indexOf(position.card);
      const neighbor = row[slot + (before ? -1 : 1)];
      // Interior guides bisect the actual gap. Outer guides remain inside the
      // card so the scroll viewport cannot clip the first/last insertion.
      const offset = neighbor ? -(before ? position.card.left-neighbor.right : neighbor.left-position.card.right)/2 - 1.5 : 0;
      closest.style.setProperty('--source-drop-offset',offset+'px');
      const members = this.records.filter(row => !row.placeholder);
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
      this.finishDrag();
      if (!pointer.dragging) return;
      this.suppressClick = {id:pointer.sourceId,time:event.timeStamp}; event.preventDefault();
      if (pointer.version !== this.version || pointer.filter !== this.filter || this.blocked) return;
      if (pointer.overTrash) { this.askRemoval(pointer.ids); return; }
      if (pointer.valid) void this.commit(pointer.ids.length === 1
        ? {action:'move',id:pointer.sourceId,before_id:pointer.before}
        : {action:'move_many',ids:pointer.ids,before_id:pointer.before},pointer.version);
    }
    clearIndicators() { for (const card of this.cards.values()) { card.classList.remove('drop-before','drop-after'); card.style.removeProperty('--source-drop-offset'); } }
    cancelHold() {
      const hold = this.hold; this.hold = null;
      if (!hold) return;
      Promise.resolve().then(() => this.options.onIdle?.());
      root.clearTimeout(hold.timer);
      if (hold.triggered) this.suppressClick = {id:hold.sourceId,time:performance.now()};
    }
    finishDrag() {
      this.toolPointer = null;
      this.cancelHold();
      const pointer = this.pointer; this.pointer = null;
      if (pointer) Promise.resolve().then(() => this.options.onIdle?.());
      pointer?.preview?.remove();
      // Canceling capture can still produce a card click on mouse release.
      if (pointer?.dragging) this.suppressClick = {id:pointer.sourceId,time:performance.now()};
      if (pointer?.target.hasPointerCapture(pointer.id)) pointer.target.releasePointerCapture(pointer.id);
      for (const card of this.cards?.values() || []) card.classList.remove('is-dragging');
      this.remove.classList.remove('drag-over');
      this.clearIndicators();
    }
  }
  root.BilikaraSourceRemoval = Object.freeze({create:(grid,options) => grid ? new SourceEditor(grid,options) : null,dropPosition});
})(window);
