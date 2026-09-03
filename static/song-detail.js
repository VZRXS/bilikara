(function initializeSongDetail(global) {
  "use strict";

  function stringValue(value) {
    return String(value ?? "").trim();
  }

  function firstValue(item, keys) {
    for (const key of keys) {
      const value = stringValue(item?.[key]);
      if (value) {
        return value;
      }
    }
    return "";
  }

  function normalizeBvidValue(value) {
    const candidate = stringValue(value);
    return /^bv[0-9a-z]+$/i.test(candidate) ? `BV${candidate.slice(2)}` : "";
  }

  function bvidFromBilibiliUrl(value) {
    const candidate = stringValue(value);
    if (!candidate) {
      return "";
    }
    try {
      const parsed = new URL(candidate);
      const hostname = parsed.hostname.toLowerCase();
      if (hostname !== "bilibili.com" && !hostname.endsWith(".bilibili.com")) {
        return "";
      }
      const match = parsed.pathname.match(/^\/video\/(bv[0-9a-z]+)(?:\/|$)/i);
      return normalizeBvidValue(match?.[1]);
    } catch {
      return "";
    }
  }

  function normalizedBvid(item) {
    const direct = stringValue(item?.bvid);
    if (direct) {
      return normalizeBvidValue(direct);
    }
    for (const key of ["url", "resolved_url", "original_url"]) {
      const recovered = bvidFromBilibiliUrl(item?.[key]);
      if (recovered) {
        return recovered;
      }
    }
    return "";
  }

  function canonicalBilibiliUrl(item) {
    const bvid = normalizedBvid(item);
    return bvid ? `https://www.bilibili.com/video/${bvid}` : "";
  }

  function renderBilibiliMetadata(elements, item, translate) {
    const bvid = normalizedBvid(item);
    const bilibiliUrl = canonicalBilibiliUrl(item);
    elements.bvid.textContent = bvid;
    elements.bvid.classList.toggle("hidden", !bvid);
    elements.bilibiliLink.textContent = bvid ? translate("search.openOnBilibili") : "";
    elements.bilibiliLink.classList.toggle("hidden", !bvid);
    if (bilibiliUrl) {
      elements.bilibiliLink.href = bilibiliUrl;
      elements.bilibiliLink.removeAttribute("aria-disabled");
      elements.bilibiliLink.removeAttribute("tabindex");
    } else {
      elements.bilibiliLink.removeAttribute("href");
      elements.bilibiliLink.setAttribute("aria-disabled", "true");
      elements.bilibiliLink.setAttribute("tabindex", "-1");
    }
    return bilibiliUrl;
  }

  function normalizeBilibiliImageUrl(value) {
    const url = stringValue(value);
    if (url.startsWith("//")) {
      return `https:${url}`;
    }
    return /^http:\/\/(?:[^./]+\.)*hdslb\.com(?=[:/]|$)/i.test(url)
      ? `https://${url.slice("http://".length)}`
      : url;
  }

  function normalizedCoverUrl(item) {
    return normalizeBilibiliImageUrl(
      firstValue(item, ["cover_url", "cover", "pic", "pic_url", "thumbnail"]),
    );
  }

  function normalizedAvatarUrl(item) {
    return normalizeBilibiliImageUrl(
      firstValue(item, ["owner_avatar_url", "owner_avatar", "avatar_url", "face"]),
    );
  }

  function ownerAvatarFromCachedOwners(item, owners) {
    const directAvatar = normalizedAvatarUrl(item);
    if (directAvatar) {
      return directAvatar;
    }
    const candidates = Array.isArray(owners) ? owners : [];
    const ownerName = firstValue(item, ["owner_name", "author"]).toLowerCase();
    const ownerMid = firstValue(item, ["owner_mid", "mid"]);
    const nameMatch = ownerName
      ? candidates.find((owner) => firstValue(owner, ["name", "owner_name"]).toLowerCase() === ownerName)
      : null;
    const uidMatch = candidates.find((owner) => firstValue(owner, ["uid", "mid"]) === ownerMid);
    const uidMatchName = firstValue(uidMatch, ["name", "owner_name"]).toLowerCase();
    const matchedOwner = nameMatch || (uidMatch && (!ownerName || uidMatchName === ownerName) ? uidMatch : null);
    return normalizedAvatarUrl(matchedOwner);
  }

  function formatDuration(value) {
    const raw = stringValue(value);
    if (!raw) {
      return "";
    }
    if (raw.includes(":")) {
      return raw;
    }
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds < 0) {
      return raw;
    }
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = String(Math.floor(seconds % 60)).padStart(2, "0");
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}`
      : `${minutes}:${remainder}`;
  }

  function formatCompactCount(value) {
    const raw = stringValue(value);
    if (!raw) {
      return "—";
    }
    const numeric = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(numeric)) {
      return raw;
    }
    if (numeric >= 100000000) {
      return `${Number((numeric / 100000000).toFixed(numeric >= 1000000000 ? 0 : 1))}亿`;
    }
    if (numeric >= 10000) {
      return `${Number((numeric / 10000).toFixed(numeric >= 100000 ? 0 : 1))}万`;
    }
    return String(Math.round(numeric));
  }

  function ratingValue(item) {
    const raw = firstValue(item, ["rank", "rating", "score"]);
    const numeric = Number(raw.replace(",", "."));
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return null;
    }
    return Math.max(0, Math.min(5, numeric));
  }

  function createSongDetailController(options) {
    const container = options?.container;
    const translate = typeof options?.t === "function" ? options.t : (key) => key;
    const onRequest = typeof options?.onRequest === "function" ? options.onRequest : async () => false;
    const onOpenExternal = typeof options?.onOpenExternal === "function" ? options.onOpenExternal : null;
    const resolveReturnFocus = typeof options?.resolveReturnFocus === "function"
      ? options.resolveReturnFocus
      : null;
    const onClose = typeof options?.onClose === "function" ? options.onClose : null;
    const requestButtonClass = stringValue(options?.requestButtonClass);
    const nextButtonClass = stringValue(options?.nextButtonClass);
    if (!container) {
      return null;
    }

    const root = document.createElement("section");
    root.className = "song-detail-view hidden";
    root.setAttribute("aria-hidden", "true");
    root.innerHTML = `
      <div class="song-detail-surface">
        <article class="song-detail-card" role="document">
          <button type="button" class="song-detail-close" data-song-detail-close aria-label="${translate("common.close")}">×</button>
          <div class="song-detail-hero">
            <div class="song-detail-cover" data-song-detail-cover>
              <span class="song-detail-cover-fallback">Bili</span>
              <span class="song-detail-duration hidden" data-song-detail-duration></span>
            </div>
            <div class="song-detail-facts">
              <h3 class="song-detail-title" data-song-detail-title></h3>
              <div class="song-detail-owner" data-song-detail-owner>
                <img class="song-detail-owner-avatar hidden" data-song-detail-owner-avatar alt="" referrerpolicy="no-referrer">
                <span class="song-detail-up-mark owner-badge" data-song-detail-up-mark>UP</span>
                <strong data-song-detail-owner-name>—</strong>
              </div>
              <div class="song-detail-bvid hidden" data-song-detail-bvid></div>
              <a class="song-detail-bilibili-link hidden" data-song-detail-bilibili-link target="_blank" rel="noopener noreferrer"></a>
              <div class="song-detail-metrics">
                <div class="song-detail-metric">
                  <span data-song-detail-plays-label></span>
                  <strong data-song-detail-plays>—</strong>
                </div>
                <div class="song-detail-metric">
                  <span data-song-detail-rating-label></span>
                  <strong data-song-detail-rating>—</strong>
                </div>
              </div>
            </div>
          </div>
          <div class="song-detail-actions">
            <button type="button" class="song-detail-request" data-song-detail-request>${translate("request.submit")}</button>
            <button type="button" class="song-detail-next" data-song-detail-next>${translate("request.moveNext")}</button>
          </div>
        </article>
      </div>`;
    container.appendChild(root);

    const elements = {
      close: root.querySelector("[data-song-detail-close]"),
      cover: root.querySelector("[data-song-detail-cover]"),
      duration: root.querySelector("[data-song-detail-duration]"),
      owner: root.querySelector("[data-song-detail-owner]"),
      ownerAvatar: root.querySelector("[data-song-detail-owner-avatar]"),
      upMark: root.querySelector("[data-song-detail-up-mark]"),
      ownerName: root.querySelector("[data-song-detail-owner-name]"),
      bvid: root.querySelector("[data-song-detail-bvid]"),
      bilibiliLink: root.querySelector("[data-song-detail-bilibili-link]"),
      playsLabel: root.querySelector("[data-song-detail-plays-label]"),
      plays: root.querySelector("[data-song-detail-plays]"),
      ratingLabel: root.querySelector("[data-song-detail-rating-label]"),
      rating: root.querySelector("[data-song-detail-rating]"),
      title: root.querySelector("[data-song-detail-title]"),
      request: root.querySelector("[data-song-detail-request]"),
      next: root.querySelector("[data-song-detail-next]"),
    };
    requestButtonClass.split(/\s+/).filter(Boolean).forEach((className) => elements.request.classList.add(className));
    nextButtonClass.split(/\s+/).filter(Boolean).forEach((className) => elements.next.classList.add(className));

    let activeItem = null;
    let activeUrl = "";
    let activeBilibiliUrl = "";
    let generation = 0;
    let closeTimer = 0;
    let previouslyFocused = null;

    function setBusy(busy, activeButton = null) {
      [elements.request, elements.next].forEach((button) => {
        button.disabled = busy || !activeUrl;
        if (busy && button === activeButton) {
          button.setAttribute("aria-busy", "true");
        } else {
          button.removeAttribute("aria-busy");
        }
      });
      elements.request.textContent = translate("request.submit");
      elements.next.textContent = translate("request.moveNext");
      if (busy && activeButton) {
        activeButton.textContent = translate("search.adding");
      }
    }

    function render(item) {
      elements.close.setAttribute("aria-label", translate("common.close"));
      elements.playsLabel.textContent = translate("search.playCountLabel");
      elements.ratingLabel.textContent = translate("search.detailRating");
      const coverUrl = normalizedCoverUrl(item);
      elements.cover.querySelector("img")?.remove();
      elements.cover.classList.toggle("is-empty", !coverUrl);
      if (coverUrl) {
        const image = document.createElement("img");
        image.alt = "";
        image.referrerPolicy = "no-referrer";
        image.src = coverUrl;
        image.decoding = "async";
        elements.cover.prepend(image);
      }

      const duration = formatDuration(firstValue(item, ["duration", "preserved_1", "length"]));
      elements.duration.textContent = duration;
      elements.duration.classList.toggle("hidden", !duration);
      elements.title.textContent = stringValue(item?.title) || stringValue(item?.bvid) || "Bilibili";
      elements.ownerName.textContent = firstValue(item, ["owner_name", "author"]) || translate("search.detailOwnerUnknown");
      activeBilibiliUrl = renderBilibiliMetadata(elements, item, translate);
      const avatarUrl = normalizedAvatarUrl(item);
      elements.ownerAvatar.classList.toggle("hidden", !avatarUrl);
      elements.upMark.classList.toggle("hidden", Boolean(avatarUrl));
      if (avatarUrl) {
        elements.ownerAvatar.src = avatarUrl;
      } else {
        elements.ownerAvatar.removeAttribute("src");
      }
      elements.plays.textContent = formatCompactCount(firstValue(item, ["played_count", "play_count", "play", "view", "views"]));
      const rating = ratingValue(item);
      elements.rating.textContent = rating == null ? "—" : `${Number(rating.toFixed(1))} / 5`;
      setBusy(false);
    }

    function open(item) {
      const itemUrl = firstValue(item, ["url", "resolved_url", "original_url"]);
      if (!itemUrl) {
        return false;
      }
      generation += 1;
      activeItem = { ...(item || {}) };
      activeUrl = itemUrl;
      previouslyFocused = document.activeElement;
      global.clearTimeout(closeTimer);
      root.classList.remove("hidden", "closing");
      root.setAttribute("aria-hidden", "false");
      render(activeItem);
      global.requestAnimationFrame(() => elements.close?.focus());
      return true;
    }

    function close({ immediate = false, restoreFocus = true, reason = "dismiss" } = {}) {
      if (root.classList.contains("hidden")) {
        return;
      }
      generation += 1;
      const closeGeneration = generation;
      const closingItem = activeItem;
      const closingFocus = previouslyFocused;
      const finish = () => {
        if (closeGeneration !== generation) {
          return;
        }
        root.classList.add("hidden");
        root.classList.remove("closing");
        root.setAttribute("aria-hidden", "true");
        activeItem = null;
        activeUrl = "";
        activeBilibiliUrl = "";
        renderBilibiliMetadata(elements, null, translate);
        if (restoreFocus) {
          const focusTarget = closingFocus?.isConnected
            ? closingFocus
            : resolveReturnFocus?.(closingFocus, closingItem);
          if (focusTarget?.isConnected && typeof focusTarget.focus === "function") {
            focusTarget.focus({ preventScroll: true });
          }
        }
        previouslyFocused = null;
        onClose?.({ item: closingItem, reason, restoredFocus: restoreFocus });
      };
      if (immediate) {
        finish();
        return;
      }
      root.classList.add("closing");
      closeTimer = global.setTimeout(finish, 220);
    }

    async function request(position) {
      if (!activeUrl || elements.request.disabled || elements.next.disabled) {
        return;
      }
      const activeButton = position === "next" ? elements.next : elements.request;
      const requestGeneration = generation;
      setBusy(true, activeButton);
      try {
        const completed = await onRequest(activeUrl, position, activeItem);
        if (completed === true && requestGeneration === generation) {
          close();
        }
      } finally {
        if (requestGeneration === generation && !root.classList.contains("hidden")) {
          setBusy(false);
        }
      }
    }

    elements.close.addEventListener("click", () => close());
    root.addEventListener("click", (event) => {
      if (!event.target.closest(".song-detail-card")) {
        close();
      }
    });
    elements.bilibiliLink.addEventListener("click", (event) => {
      if (!activeBilibiliUrl) {
        event.preventDefault();
        return;
      }
      if (onOpenExternal) {
        event.preventDefault();
        onOpenExternal(activeBilibiliUrl);
      }
    });
    elements.request.addEventListener("click", () => request("tail"));
    elements.next.addEventListener("click", () => request("next"));
    root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    });

    return {
      open,
      close,
      isOpen: () => !root.classList.contains("hidden"),
      root,
    };
  }

  global.BilikaraSongDetail = {
    canonicalBilibiliUrl,
    createSongDetailController,
    normalizeBilibiliImageUrl,
    normalizedBvid,
    ownerAvatarFromCachedOwners,
  };
})(window);
