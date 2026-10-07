import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
import { contains, hasContent, sourceIndex, iterableValues, countOccurrences } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const BlacklistReviewIntegrationTest = {
async test_developer_catalog_tools_expose_blacklist_below_pending_review() {
let blacklist_index, html, review_index;
html = readFileSync(path.join(path.join(ROOT, "static"), "index.html"), "utf8");
review_index = sourceIndex(html, "data-catalog-tool=\"review\"");
blacklist_index = sourceIndex(html, "data-catalog-tool=\"blacklist\"");
assert.ok(review_index < blacklist_index);
assert.ok(contains("data-i18n=\"search.blacklistBrowse\"", html));
assert.ok(contains("class=\"catalog-advanced developer-only\"", html));
},
async test_frontend_separates_review_rejection_from_generic_delete() {
let source;
source = readFileSync(path.join(path.join(ROOT, "static"), "app.js"), "utf8");
assert.ok(contains("action = \"reject-entry\"", source));
assert.ok(contains("apiPost(\"/api/admin-review/reject\"", source));
assert.ok(contains("releaseButton.dataset.devAction = \"blacklist-release\"", source));
assert.ok(contains("restoreButton.dataset.devAction = \"blacklist-release-restore\"", source));
assert.ok(contains("apiPost(\"/api/admin-blacklist/restore\"", source));
assert.ok(contains("apiPost(\"/api/admin-video/delete\"", source));
},
async test_developer_mode_exposes_maintenance_workflow_triggers() {
let frontend, html, server;
html = readFileSync(path.join(path.join(ROOT, "static"), "index.html"), "utf8");
frontend = readFileSync(path.join(path.join(ROOT, "static"), "app.js"), "utf8");
server = readFileSync(path.join(path.join(ROOT, "bilikara"), "server.py"), "utf8");
assert.deepEqual(countOccurrences(html, "data-catalog-tool=\"maintenance\""), 1);
assert.ok(!contains("data-target=\"maintenance\"", html));
assert.deepEqual(countOccurrences(html, "data-catalog-tool=\"review\""), 1);
assert.deepEqual(countOccurrences(html, "data-catalog-tool=\"blacklist\""), 1);
assert.ok(contains("id=\"catalog-advanced-content\"", html));
assert.ok(!contains("id=\"search-modal-other-view\"", html));
assert.ok(contains("apiPost(\"/api/admin-maintenance/trigger\"", frontend));
assert.ok(contains("elements.catalogAdvancedContent.textContent = \"\"", frontend));
assert.ok(contains("[\"review\", \"blacklist\", \"maintenance\"]", frontend));
assert.ok(contains("route == \"/api/admin-maintenance/trigger\"", server));
assert.ok(contains("button.disabled = Boolean(state.maintenanceJobRunning);", frontend));
assert.ok(!contains("button.setAttribute(\"aria-disabled\", \"true\")", frontend));
},
async test_maintenance_translations_exist_in_all_languages() {
let locale, payload, required;
payload = JSON.parse(readFileSync(path.join(path.join(ROOT, "static"), "i18n.json"), "utf8"));
required = new Set(["maintenance.browse", "maintenance.title", "maintenance.description", "maintenance.monthlyTitle", "maintenance.monthlyDescription", "maintenance.taggerYomiTitle", "maintenance.taggerYomiDescription", "maintenance.start", "maintenance.starting", "maintenance.started"]);
for (const locale of iterableValues(["zh", "en", "ja"])) {
{
assert.ok(hasContent(Array.from(required).every(value => contains(value, payload["languages"][locale]))));
}
}
},
async test_tauri_packages_the_shared_frontend_and_native_backend() {
let backend_source, bundle_source, tauri;
tauri = JSON.parse(readFileSync(path.join(path.join(ROOT, "src-tauri"), "tauri.conf.json"), "utf8"));
backend_source = readFileSync(path.join(path.join(path.join(ROOT, "src-tauri"), "src"), "backend_process.rs"), "utf8");
bundle_source = readFileSync(path.join(path.join(path.join(ROOT, "xtask"), "src"), "files.rs"), "utf8");
assert.deepEqual(tauri["build"]["frontendDist"], "../static");
assert.ok(contains("\"bilikara-desktop-host.exe\"", backend_source));
assert.ok(contains("\"bilikara-desktop-host\"", backend_source));
assert.ok(contains("let source_static = config.root.join(\"static\")", bundle_source));
assert.ok(contains("copy(&entry.path(), &assets.join(entry.file_name()))?", bundle_source));
}
};
test("BlacklistReviewIntegrationTest.test_developer_catalog_tools_expose_blacklist_below_pending_review", async () => { const instance = Object.create(BlacklistReviewIntegrationTest); await instance.test_developer_catalog_tools_expose_blacklist_below_pending_review(); });
test("BlacklistReviewIntegrationTest.test_frontend_separates_review_rejection_from_generic_delete", async () => { const instance = Object.create(BlacklistReviewIntegrationTest); await instance.test_frontend_separates_review_rejection_from_generic_delete(); });
test("BlacklistReviewIntegrationTest.test_developer_mode_exposes_maintenance_workflow_triggers", async () => { const instance = Object.create(BlacklistReviewIntegrationTest); await instance.test_developer_mode_exposes_maintenance_workflow_triggers(); });
test("BlacklistReviewIntegrationTest.test_maintenance_translations_exist_in_all_languages", async () => { const instance = Object.create(BlacklistReviewIntegrationTest); await instance.test_maintenance_translations_exist_in_all_languages(); });
test("BlacklistReviewIntegrationTest.test_tauri_packages_the_shared_frontend_and_native_backend", async () => { const instance = Object.create(BlacklistReviewIntegrationTest); await instance.test_tauri_packages_the_shared_frontend_and_native_backend(); });
