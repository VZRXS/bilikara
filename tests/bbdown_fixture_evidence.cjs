"use strict";
// Only synthetic child identities, never tool output, URLs, cookies or state payloads.
const fs = require("node:fs/promises"), path = require("node:path");
const identity = value => typeof value === "string" && /^[\w.-]{1,100}$/.test(value) ? value : undefined;
function itemIdentity(item) {
  return Object.fromEntries(["id", "item_incarnation_id", "artifact_set_id", "cache_status"]
    .map(key => [key, identity(item?.[key])]).filter(([, value]) => value !== undefined));
}
async function retryEvidence({root, directory, failure, before, after, files}) {
  const children = [];
  for (const file of files.slice(0, 8)) {
    if (!/^\d+\.started$/.test(file)) continue;
    const handle = await fs.open(path.join(root, file), "r");
    let receipt;
    try {
      const buffer = Buffer.alloc(4096), {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
      receipt = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/);
    } finally {await handle.close();}
    const [kind, page, mode, work] = receipt;
    const relative = work && path.relative(path.join(directory, "cache"), work);
    const parts = relative?.split(path.sep);
    const staged = parts?.length === 4 && parts[0] === ".staging" && parts.slice(1).every(identity);
    children.push({pid: Number(file.split(".")[0]),
      kind: ["audio", "video"].includes(kind) ? kind : "invalid",
      page: /^\d{1,4}$/.test(page || "") ? Number(page) : undefined,
      mode: ["success", "slow", "missing", "invalid", "exit", "hold", "late", "late_hold"].includes(mode) ? mode : "invalid",
      ...(staged ? {item_incarnation_id: parts[1], artifact_set_id: parts[2], track: parts[3]} : {invalid_work_directory: true})});
  }
  return {failure: ["missing", "invalid", "exit", "case"].includes(failure) ? failure : "invalid",
    before: itemIdentity(before), after: itemIdentity(after), child_count: files.length, children};
}
module.exports = {retryEvidence};
