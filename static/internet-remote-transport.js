(function installInternetRemoteTransport(global) {
  "use strict";

  const encoder = new TextEncoder();
  const MAX_FRAME_BYTES = 12 * 1024;
  const MAX_TRANSFER_BYTES = 512 * 1024;
  const MAX_REQUEST_BYTES = 16 * 1024;
  const MAX_PENDING_BYTES = 4 * 1024 * 1024;
  const CHUNK_BYTES = 9 * 1024;
  // A serialized quote/backslash occupies two bytes in a chunk's JSON string.
  const MAX_CHUNKS = Math.ceil(MAX_TRANSFER_BYTES * 2 / (CHUNK_BYTES - 3));
  const MAX_PENDING_TRANSFERS = 8;

  function utf8Bytes(value) {
    return encoder.encode(String(value)).byteLength;
  }

  function checkSerializedSize(serialized, limitBytes) {
    const bytes = utf8Bytes(serialized);
    if (bytes > limitBytes) {
      const error = new Error("Internet Remote message is too large");
      error.code = "internet_remote_message_too_large";
      error.limitBytes = limitBytes;
      throw error;
    }
    return bytes;
  }

  function checkMessageSize(payload, limitBytes = MAX_TRANSFER_BYTES) {
    return checkSerializedSize(JSON.stringify(payload), limitBytes);
  }

  const PAGED_READS = new Set([
    "catalog.search", "catalog.browse", "catalog.category_browse",
    "gatcha.search", "gatcha.browse", "gatcha.favlist_browse",
  ]);

  // This is a public display projection, never a mutation of Host state. Only
  // queue/history prefixes and known read-result pages may lose visible rows.
  function prepareDisplayMessage(message, request = {}) {
    const data = message?.data;
    if (["gatcha.pool_config_get", "gatcha.pool_config_set", "gatcha.favlist_preview"].includes(request.kind)
      && (data?.public_list_limits || data?.cache?.public_list_limits)) {
      // An incomplete editable source selection must not become a saved draft.
      const error = new Error("Internet Remote source selection is incomplete");
      error.code = "internet_remote_source_list_incomplete";
      throw error;
    }
    try { checkMessageSize(message); return message; }
    catch (error) { if (error.code !== "internet_remote_message_too_large") throw error; }

    const nested = Array.isArray(data?.state?.playlist) ? data.state : null;
    const isState = message.type === "state" || Boolean(nested)
      || (message.type === "response" && Array.isArray(data?.playlist));
    const view = nested || data;
    const paged = !isState && PAGED_READS.has(request.kind) && Array.isArray(data?.items);
    const offset = Number.isSafeInteger(view?.offset) ? view.offset : Number(request.body?.offset || 0);
    if (paged && typeof view.has_more === "boolean"
      && (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(view.next_offset)
        || view.next_offset !== offset + view.items.length)) {
      // A sparse/opaque cursor cannot be rewound from visible row counts.
      // Never skip unseen rows by inventing a continuation for that page.
      checkMessageSize(message);
    }
    const fields = isState ? ["playlist", "history"] : paged ? ["items"] : [];
    const lists = fields.filter(key => Array.isArray(view?.[key]) && view[key].length).map(key => {
      const values = view[key], bytes = [0];
      for (const value of values) bytes.push(bytes.at(-1) + utf8Bytes(JSON.stringify(value) ?? "null")
        + (bytes.length > 1 ? 1 : 0));
      return {key,values,bytes,minimum:key === "history" ? 0 : 1};
    });
    const rebuild = (lengths, reserveCountWidth = false) => {
      const next = {...view}, limits = {...view?.public_list_limits};
      for (const [index,list] of lists.entries()) {
        const shown = lengths[index];
        next[list.key] = list.values.slice(0, shown);
        if (shown < list.values.length) limits[list.key] = {
          total: Number.isSafeInteger(limits[list.key]?.total)
            ? Math.max(list.values.length, limits[list.key].total) : list.values.length,
          shown:reserveCountWidth ? list.values.length : shown,
          ...(paged ? {paged:typeof view.has_more === "boolean"} : {}),
        };
      }
      if (Object.keys(limits).length) next.public_list_limits = limits;
      if (paged && typeof view.has_more === "boolean") {
        next.next_offset = offset + (reserveCountWidth ? lists[0].values.length : lengths[0]);
        next.has_more = lengths[0] < lists[0].values.length || view.has_more;
      }
      return nested ? {...message,data:{...data,state:next}} : {...message,data:next};
    };
    if (!lists.length) { checkMessageSize(message); return message; }
    const minima = lists.map(list => list.minimum);
    const fixed = utf8Bytes(JSON.stringify(rebuild(lists.map(() => 0), true)));
    const reserved = lists.reduce((sum,list) => sum + list.bytes[list.minimum], 0);
    const available = MAX_TRANSFER_BYTES - fixed - reserved;
    if (available < 0) { checkMessageSize(message); return message; }
    const remaining = lists.reduce((sum,list) => sum + list.bytes.at(-1) - list.bytes[list.minimum], 0);
    const lengths = lists.map((list,index) => {
      const budget = list.bytes[list.minimum] + (remaining
        ? Math.floor(available * (list.bytes.at(-1) - list.bytes[list.minimum]) / remaining) : 0);
      let low = minima[index], high = list.values.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (list.bytes[middle] <= budget) low = middle; else high = middle - 1;
      }
      return low;
    });
    const result = rebuild(lengths);
    checkMessageSize(result);
    return result;
  }

  function randomBase64Url(byteLength) {
    const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  }

  function base64Url(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  }

  async function sha256(value) {
    return base64Url(new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(String(value))),
    ));
  }

  function constantTimeTextEqual(left, right) {
    const leftBytes = encoder.encode(String(left));
    const rightBytes = encoder.encode(String(right));
    if (leftBytes.byteLength !== rightBytes.byteLength) return false;
    let difference = 0;
    for (let index = 0; index < leftBytes.byteLength; index += 1) {
      difference |= leftBytes[index] ^ rightBytes[index];
    }
    return difference === 0;
  }

  function splitText(value, targetBytes = CHUNK_BYTES) {
    const chunks = [];
    let current = "";
    let bytes = 0;
    for (const character of value) {
      // The input is already serialized JSON, so only these two characters
      // need additional escaping when it becomes the frame's data string.
      const size = utf8Bytes(character) + (character === '"' || character === "\\" ? 1 : 0);
      if (current && bytes + size > targetBytes) {
        chunks.push(current);
        current = "";
        bytes = 0;
      }
      current += character;
      bytes += size;
    }
    if (current) chunks.push(current);
    return chunks;
  }

  function* frames(payload) {
    const serialized = JSON.stringify(payload);
    const totalBytes = checkSerializedSize(serialized, MAX_TRANSFER_BYTES);
    if (totalBytes <= MAX_FRAME_BYTES) {
      yield serialized;
      return;
    }
    const transferId = crypto.randomUUID();
    const chunks = splitText(serialized);
    for (const [index, data] of chunks.entries()) {
      const frame = JSON.stringify({
        type: "__chunk",
        transfer_id: transferId,
        index,
        total: chunks.length,
        total_bytes: totalBytes,
        data,
      });
      if (utf8Bytes(frame) > MAX_FRAME_BYTES) throw new Error("Internet Remote frame is too large");
      yield frame;
    }
  }

  function send(channel, payload, { buffered = false } = {}) {
    if (!channel || channel.readyState !== "open") throw new Error("DataChannel is not open");
    if (buffered) {
      return (async () => {
        for (const frame of frames(payload)) {
          await waitForBufferedAmount(channel);
          channel.send(frame);
        }
      })();
    }
    for (const frame of frames(payload)) channel.send(frame);
  }

  class Decoder {
    constructor() {
      this.pending = new Map();
    }

    consume(raw) {
      const text = String(raw);
      if (utf8Bytes(text) > MAX_FRAME_BYTES) throw new Error("Internet Remote frame is too large");
      const frame = JSON.parse(text);
      if (!frame || frame.type !== "__chunk") return [frame];
      const { transfer_id: id, index, total, total_bytes: totalBytes, data } = frame;
      if (
        typeof id !== "string" || typeof data !== "string"
        || !Number.isInteger(index) || !Number.isInteger(total) || !Number.isInteger(totalBytes)
        || index < 0 || total < 2 || total > MAX_CHUNKS || index >= total
        || totalBytes < 1 || totalBytes > MAX_TRANSFER_BYTES
      ) throw new Error("Invalid Internet Remote chunk");
      const cutoff = Date.now() - 30_000;
      for (const [key, item] of this.pending) {
        if (item.createdAt < cutoff) this.pending.delete(key);
      }
      let item = this.pending.get(id);
      if (!item) {
        if (this.pending.size >= MAX_PENDING_TRANSFERS
          || [...this.pending.values()].reduce((sum, entry) => sum + entry.totalBytes, totalBytes) > MAX_PENDING_BYTES) throw new Error("Too many Internet Remote transfers");
        item = { createdAt: Date.now(), total, totalBytes, chunks: new Array(total), received: 0, receivedBytes: 0 };
        this.pending.set(id, item);
      }
      if (item.total !== total || item.totalBytes !== totalBytes) throw new Error("Mismatched Internet Remote chunk");
      if (item.chunks[index] === undefined) {
        item.receivedBytes += utf8Bytes(data);
        if (item.receivedBytes > item.totalBytes) {
          this.pending.delete(id);
          throw new Error("Corrupt Internet Remote transfer");
        }
        item.chunks[index] = data;
        item.received += 1;
      }
      if (item.received !== total) return [];
      this.pending.delete(id);
      const joined = item.chunks.join("");
      if (utf8Bytes(joined) !== totalBytes) throw new Error("Corrupt Internet Remote transfer");
      return [JSON.parse(joined)];
    }
  }

  function waitForIceGathering(peer, timeoutMs = 8_000) {
    if (peer.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        peer.removeEventListener("icegatheringstatechange", check);
        resolve();
      };
      const check = () => {
        if (peer.iceGatheringState === "complete") done();
      };
      peer.addEventListener("icegatheringstatechange", check);
      setTimeout(done, timeoutMs);
    });
  }

  // Keep the initial, candidate-bearing SDP for released clients. Candidates
  // found after that bounded wait still need signaling, especially on slow
  // STUN paths. Incoming candidates may precede setRemoteDescription completion.
  function createIceCandidateExchange(peer, { isCurrent, sendCandidate, onError }) {
    let localDescriptionSent = false;
    let remoteDescriptionReady = false;
    let pending = [];
    let received = 0;
    let tail = Promise.resolve();
    peer.addEventListener("icecandidate", (event) => {
      if (!localDescriptionSent || !event.candidate || !isCurrent()) return;
      try { sendCandidate(event.candidate.toJSON()); }
      catch (error) { if (isCurrent()) onError(error); }
    });
    function apply(candidate) {
      const operation = tail.then(() => {
        if (isCurrent()) return peer.addIceCandidate(candidate);
      });
      tail = operation.catch(() => {});
      return operation;
    }
    return {
      descriptionSent() { localDescriptionSent = true; },
      async setRemoteDescription(description) {
        await peer.setRemoteDescription(description);
        if (!isCurrent()) { pending = []; return; }
        remoteDescriptionReady = true;
        const operations = pending.map(apply);
        pending = [];
        await Promise.all(operations);
      },
      async addCandidate(candidate) {
        if (!isCurrent()) return;
        if (!candidate || typeof candidate.candidate !== "string"
          || utf8Bytes(candidate.candidate) > 4 * 1024 || ++received > 128) {
          throw new Error("Invalid or excessive Internet Remote ICE candidates");
        }
        if (!remoteDescriptionReady) pending.push(candidate);
        else await apply(candidate);
      },
    };
  }

  function waitForBufferedAmount(channel, timeoutMs = 10_000) {
    const highWaterMark = 128 * 1024;
    if (!channel || channel.readyState !== "open") return Promise.reject(new Error("DataChannel is not open"));
    if (channel.bufferedAmount <= highWaterMark) return Promise.resolve();
    channel.bufferedAmountLowThreshold = 64 * 1024;
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        channel.removeEventListener("bufferedamountlow", drained);
        channel.removeEventListener("close", closed);
      };
      const drained = () => { cleanup(); resolve(); };
      const closed = () => { cleanup(); reject(new Error("DataChannel closed while draining")); };
      channel.addEventListener("bufferedamountlow", drained, { once: true });
      channel.addEventListener("close", closed, { once: true });
      timer = setTimeout(() => { cleanup(); reject(new Error("DataChannel backpressure timeout")); }, timeoutMs);
    });
  }

  global.BilikaraInternetTransport = {
    Decoder,
    constantTimeTextEqual,
    randomBase64Url,
    checkMessageSize,
    prepareDisplayMessage,
    maxMessageBytes: MAX_TRANSFER_BYTES,
    maxRequestBytes: MAX_REQUEST_BYTES,
    send,
    sha256,
    createIceCandidateExchange,
    waitForBufferedAmount,
    waitForIceGathering,
    iceConfiguration: {
      iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }],
      iceCandidatePoolSize: 0,
    },
  };
})(globalThis);
