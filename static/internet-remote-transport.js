(function installInternetRemoteTransport(global) {
  "use strict";

  const encoder = new TextEncoder();
  const MAX_FRAME_BYTES = 12 * 1024;
  const MAX_TRANSFER_BYTES = 512 * 1024;
  const MAX_PENDING_TRANSFERS = 8;

  function utf8Bytes(value) {
    return encoder.encode(String(value)).byteLength;
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

  function splitText(value, targetBytes = 9 * 1024) {
    const chunks = [];
    let current = "";
    let bytes = 0;
    for (const character of value) {
      const size = utf8Bytes(character);
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

  function send(channel, payload) {
    if (!channel || channel.readyState !== "open") throw new Error("DataChannel is not open");
    const serialized = JSON.stringify(payload);
    const totalBytes = utf8Bytes(serialized);
    if (totalBytes > MAX_TRANSFER_BYTES) throw new Error("Internet Remote message is too large");
    if (totalBytes <= MAX_FRAME_BYTES) {
      channel.send(serialized);
      return;
    }
    const transferId = crypto.randomUUID();
    const chunks = splitText(serialized);
    chunks.forEach((data, index) => {
      const frame = JSON.stringify({
        type: "__chunk",
        transfer_id: transferId,
        index,
        total: chunks.length,
        total_bytes: totalBytes,
        data,
      });
      if (utf8Bytes(frame) > MAX_FRAME_BYTES) throw new Error("Internet Remote frame is too large");
      channel.send(frame);
    });
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
        || index < 0 || total < 2 || total > 128 || index >= total
        || totalBytes < 1 || totalBytes > MAX_TRANSFER_BYTES
      ) throw new Error("Invalid Internet Remote chunk");
      const cutoff = Date.now() - 30_000;
      for (const [key, item] of this.pending) {
        if (item.createdAt < cutoff) this.pending.delete(key);
      }
      let item = this.pending.get(id);
      if (!item) {
        if (this.pending.size >= MAX_PENDING_TRANSFERS) throw new Error("Too many Internet Remote transfers");
        item = { createdAt: Date.now(), total, totalBytes, chunks: new Array(total), received: 0 };
        this.pending.set(id, item);
      }
      if (item.total !== total || item.totalBytes !== totalBytes) throw new Error("Mismatched Internet Remote chunk");
      if (item.chunks[index] === undefined) {
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
    send,
    sha256,
    waitForBufferedAmount,
    waitForIceGathering,
    iceConfiguration: {
      iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }],
      iceCandidatePoolSize: 0,
    },
  };
})(globalThis);
