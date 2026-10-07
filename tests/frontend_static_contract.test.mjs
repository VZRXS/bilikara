import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Static source contracts remain source contracts; these do not qualify native GUI.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const read = file => readFileSync(path.join(root, file), 'utf8');
const host = read('static/index.html'), remote = read('static/remote.html'), app = read('static/app.js'), translations = JSON.parse(read('static/i18n.json')).languages;
const includes = (source, values) => { for (const value of values) assert.ok(source.includes(value), value); };
const excludes = (source, values) => { for (const value of values) assert.ok(!source.includes(value), value); };
const between = (source, from, to) => { const start = source.indexOf(from); assert.ok(start >= 0); const end = source.indexOf(to, start); assert.ok(end > start); return source.slice(start, end); };

test('Windows display recovery is installed independently of web controls before startup', () => {
  const desktop = read('src-tauri/src/desktop.rs');
  const setup = between(desktop, '.setup(move |app| {', '.on_window_event');
  assert.ok(setup.indexOf('install_display_change_handler(&window)') >= 0);
  assert.ok(setup.indexOf('install_display_change_handler(&window)') < setup.indexOf('desktop_import::gate_startup'));
  const native = read('src-tauri/src/windows_display.rs');
  includes(native, ['WM_DISPLAYCHANGE', 'WM_SETTINGCHANGE', 'PostMessageW', 'WM_NCDESTROY', 'RemoveWindowSubclass', 'is_fullscreen()', 'state.restoring', 'SetWindowPlacement']);
  excludes(native, ['setInterval', 'window.unmaximize(', 'window.show(', 'window.set_focus(']);
});

test('shared category declarations and full-field tags retain Host/Remote parity', () => {
  const other = read('static/remote.js');
  function definitions(text, name) { const block = text.match(new RegExp(`const ${name} = \\[(.*?)\\n\\];`, 's')); assert.ok(block); return Object.fromEntries([...block[1].matchAll(/\{\s*key:\s*"([^"]+)",\s*tags:\s*\[(.*?)\]\s*\}/gs)].map(([, key, tags]) => [key, [...tags.matchAll(/"([^"]+)"/g)].map(v => v[1])])); }
  assert.deepEqual(definitions(other, 'categoryBrowseDefinitionsRaw'), definitions(app, 'CATEGORY_BROWSE_DEFINITIONS'));
  function tags(text, name) { const block = text.match(new RegExp(`const ${name} = new Set\\(\\[(.*?)\\]\\.map`, 's')); assert.ok(block); return [...block[1].matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map(v => v[1]); }
  assert.deepEqual(tags(other, 'categoryBrowseFullFieldTags'), tags(app, 'CATEGORY_BROWSE_FULL_FIELD_TAGS'));
});

test('Android display bridge keeps origin, role/generation, local rendering and no Remote adapter', () => {
  const native = read('src-tauri/gen/android/app/src/main/java/com/bilikara/app/HostPresentation.kt');
  includes(native, ['sourceOrigin != expected', '!isMainFrame', 'view !== output', 'generation != windowGeneration', 'listOf("/controller.html")', 'listOf("/", "/index.html")', 'setOf(origin)', 'args.optLong("generation", -1) == generation', 'DisplayManager.DISPLAY_CATEGORY_PRESENTATION', 'allowFileAccess = false', 'allowContentAccess = false', 'setSupportMultipleWindows(false)', 'while (events.size > 40)', 'remove("name")', 'oldView?.destroy()']);
  excludes(native, ['addJavascriptInterface', 'setOf("*")', 'MediaPlayer(', 'ExoPlayer', '/api/player/', 'SESSDATA', 'getCookie(']);
  for (const text of [host, read('static/controller.html')]) assert.ok(text.indexOf('/android-presentation.js') < text.indexOf(text === host ? '/app.js' : '/controller.js')); excludes(remote, ['/android-presentation.js']);
});

test('shared desktop layout stays responsive and Android follows system rotation without manual selectors', () => {
  assert.ok(host.indexOf('/android-layout.js') < host.indexOf('/host-layout.js')); includes(host, ['/host-layout-preferences.js']); excludes(remote, ['/android-layout.js', '/host-layout.js']); excludes(host, ['id="android-layout-settings"', 'data-android-layout-mode=', 'id="android-orientation-settings"', 'data-android-orientation-mode=']);
  for (const locale of ['zh', 'ja', 'en']) for (const key of ['layout', 'layoutAuto', 'layoutDesktop', 'layoutPhone', 'layoutHint', 'windowPreferenceFailed']) assert.ok(translations[locale][`mobile.${key}`]);
  const native = read('src-tauri/gen/android/app/src/main/java/com/bilikara/app/HostWindowControls.kt');
  includes(native, ['private val preferences by lazy', 'getSharedPreferences("host-window", Context.MODE_PRIVATE)', 'setOf(origin)', '!isMainFrame', 'sourceOrigin != expected', 'listOf("/", "/index.html")', 'raw.length > 1024', 'require(mode in layoutModes)', 'require(mode in orientationModes)', 'previousOrientation = activity.requestedOrientation', 'activity.requestedOrientation = previousOrientation']); excludes(native, ['addJavascriptInterface', 'setOf("*")', 'webView.reload(', 'loadUrl(']);
  includes(native, ['activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED']);
  excludes(native, ['requestedDirection(snapshot().getString("orientation"))']);
});

test('Android pages/languages/visibility reuse native desktop source defaults and keep Remote separate', () => {
  includes(host, ['/android-host.js', '/host-layout.css', '/host-layout.js', '/native-session.js']); excludes(remote, ['/android-host.js']);
  for (const page of ['playback', 'queue', 'request', 'users', 'my']) assert.equal(host.split(`data-android-page="${page}"`).length - 1, 1);
  for (const locale of ['zh', 'ja', 'en']) for (const key of ['navigation', 'playback', 'queue', 'me', 'backToMe', 'settingsHint', 'downloadSettings', 'loginPersistence']) assert.ok(translations[locale][`mobile.${key}`]);
  assert.ok(host.indexOf('/app.js') < host.indexOf('/android-playback.js')); assert.ok(host.indexOf('/android-playback.js') < host.indexOf('/android-host.js'));
  const expected = ['3145040', '671767', '33091201', '3494356589742209', '44627483', '8474818', '10077309', '74089392', '1879151', '87101327', '99061404', '602998', '1159885664', '215040', '31624333', '21129450', '2625848', '29955371', '3014315', '80148988', '464873', '41924655', '356716', '174980119', '1326466', '13775191', '524220885'];
  const native = JSON.parse(read('rust-runtime/src/native_host/default_uids.json')); assert.deepEqual(native, expected); assert.equal(native.length, new Set(native).size);
  // Retained source Host still consumes this table until its active gap closes.
  assert.deepEqual(JSON.parse(read('bilikara/config.py').match(/^GATCHA_UIDS = (\[[^\n]+\])/m)[1]), expected);
});

test('hidden main geometry precedes backend launch; accepted ready alone shows/focuses/navigates', () => {
  const desktop = read('src-tauri/src/desktop.rs'), lifecycle = read('src-tauri/src/window_lifecycle.rs'), backend = read('src-tauri/src/backend_process.rs'), cargo = read('src-tauri/Cargo.toml');
  const setup = between(desktop, '.setup(move |app| {', '.on_window_event'); includes(setup, ['window_lifecycle::initialize_main_window_geometry(app, &window)', 'create_macos_main_webview_window(app)?']); assert.ok(setup.indexOf('create_macos_main_webview_window') < setup.indexOf('initialize_main_window_geometry')); assert.ok(setup.indexOf('initialize_main_window_geometry') < setup.indexOf('desktop_import::gate_startup'));
  const gate = read('src-tauri/src/desktop_import.rs'); includes(gate, ['needs_startup_inspection', 'workflow(&app, true)', 'crate::backend_process::launch(&app, window, startup_log)']);
  // Windows must consume imported preferences before the first hidden-window
  // restore, while macOS/Linux retain their existing creation/restore order.
  includes(setup, ['#[cfg(not(windows))]\n            window_lifecycle::initialize_main_window_geometry(app, &window);']);
  const nativeGate = between(gate, 'pub(crate) fn gate_startup(', 'fn workflow(');
  const fastPath = between(nativeGate, 'if matches!(needed, Ok(false)) {', 'let app = app.handle().clone();');
  const firstStart = between(nativeGate, 'Ok(true) if app.get_webview_window("main").is_some() => {', 'Ok(_) => app.exit(0)');
  for (const branch of [fastPath, firstStart]) {
    includes(branch, ['#[cfg(windows)]', 'initialize_main_window_geometry', 'backend_process::launch']);
    assert.ok(branch.indexOf('initialize_main_window_geometry') < branch.indexOf('backend_process::launch'));
  }
  const success = between(gate, 'fn success(app:', 'fn choose_folder(');
  assert.ok(success.indexOf('import_old_window_settings(report)') < success.indexOf('success_message(report,'));
  includes(success, ['cleanup_folders(report,', '"打开文件夹".into()', '"完成".into()', 'blocking_show_with_result()', 'cleanup_button_selected(&result)', 'open_cleanup_folders(&folders, crate::platform::open_existing_directory)']);
  const windows = JSON.parse(read('src-tauri/tauri.conf.json')).app.windows; assert.deepEqual(windows.map(v => v.label), ['main']); assert.equal(windows[0].visible, false); excludes(lifecycle, ['.show()', 'tauri_plugin_window_state']); excludes(cargo, ['tauri-plugin-window-state']); includes(lifecycle, ['const MAIN_WINDOW_LABEL: &str = "main";', 'if window.label() != MAIN_WINDOW_LABEL']); excludes(lifecycle.slice(0, lifecycle.indexOf('async fn prepare_application_restart_on_main_thread')), ['controller']);
  const accepted = between(backend.slice(backend.indexOf('let result = drain_backend_stdout(')), '|ready| {', '|line| {'); assert.equal(backend.split('window_clone.show()').length - 1, 1); assert.equal(accepted.split('window_clone.show()').length - 1, 1);
  for (const [a, b] of [['ready_for_reader.store(true', 'window_clone.show()'], ['window_clone.show()', 'window_clone.set_focus()'], ['window_clone.set_focus()', 'window.location.replace']]) assert.ok(accepted.indexOf(a) < accepted.indexOf(b));
});

test('caption locale/icon updates and native pointer regions preserve authorization and lifecycle', () => {
  for (const locale of ['zh', 'en', 'ja']) for (const key of ['controls', 'minimize', 'maximize', 'restore', 'close']) assert.ok(translations[locale][`window.${key}`]);
  for (const action of ['minimize', 'maximize', 'close']) includes(host, [`data-i18n-title="window.${action}"`, `data-i18n-aria-label="window.${action}"`]);
  const render = between(app, 'function renderWindowMaximizeState', 'function initializeNativeMaximizeRegion'); includes(render, ['"window.restore" : "window.maximize"', '.window-restore-icon', 'toggleAttribute("hidden"', 'nativeWindows ? "" : t(key)']); excludes(render, ['textContent']); excludes(read('static/styles.css'), ['.window-control-button.is-native-hovered::after']); includes(app, ['request === frameStateRequest', 'window.devicePixelRatio']);
  const native = read('src-tauri/src/window_chrome.rs'); includes(native, ['authorize_window(&window, &backend, &["main"])', 'region.is_some_and', 'return HTMAXBUTTON as LRESULT', 'SendMessageW(parent, message, wp, lp)', 'DwmDefWindowProc(hwnd', 'WM_NCDESTROY', 'Box::from_raw', 'WM_DPICHANGED', 'DefSubclassProc(hwnd, message, wp, lp)', 'SetCapture(hwnd)', 'WM_LBUTTONUP | WM_NCLBUTTONUP', 'PostMessageW(parent, WM_SYSCOMMAND']); excludes(native, ['eval(']);
  const region = between(app, 'function initializeNativeMaximizeRegion', 'function initializeWindowChrome'); includes(region, ['if (pending)', 'sent === signature', '!isPlayerPanelFullscreen()', '!presentationCompositionActive()']); excludes(region, ['setInterval', 'toggleMaximize']);
});

test('Linux/macOS caption controls and shared palette stay native', () => {
  includes(read('src-tauri/src/platform.rs'), ['gtk::HeaderBar::new()', 'header.set_show_close_button(true)', 'gtk_window.is_realized()']); const window = JSON.parse(read('src-tauri/tauri.macos.conf.json')).app.windows[0]; assert.equal(window.decorations, true); assert.equal(window.titleBarStyle, 'Overlay'); includes(app, ['getPropertyValue("--bg-middle")', 'getPropertyValue("--ink")']);
});

test('manual bundle labels do not authorize publication/mirroring', () => {
  const workflow = read('.github/workflows/ci-bundle.yml'); includes(workflow, ['bundle_version:', "BILIKARA_VERSION: ${{ github.event_name == 'workflow_dispatch' && inputs.bundle_version || '' }}", "github.ref_name || inputs.bundle_version || ''", "-preview\\.[0-9]+)?$'"]);
  const release = workflow.slice(workflow.indexOf('- name: Upload bundle to GitHub Release')); assert.ok(release.split('\n')[1].includes("if: startsWith(github.ref, 'refs/tags/v')")); assert.ok(workflow.slice(workflow.indexOf('  mirror-release-r2:'), workflow.indexOf('  mirror-release-r2:') + 400).includes("if: startsWith(github.ref, 'refs/tags/v')"));
});

test('all real Cargo/Node application manifests and lock roots preserve the release version and shell boundary', async () => {
  const expected = '0.8.0'; assert.equal(JSON.parse(read('src-tauri/tauri.conf.json')).version, expected);
  for (const manifest of ['src-tauri', 'rust', 'rust-runtime']) { const result = await runNative('cargo', ['metadata', '--manifest-path', path.join(root, manifest, 'Cargo.toml'), '--locked', '--no-deps', '--format-version=1']); assert.equal(result.status, 0, result.stderr); const metadata = JSON.parse(result.stdout), member = metadata.packages.find(v => path.resolve(v.manifest_path) === path.join(root, manifest, 'Cargo.toml')); assert.ok(member); assert.equal(member.version, expected); if (manifest === 'src-tauri') { const lib = member.targets.find(v => v.name === 'bilikara_app'); assert.deepEqual(new Set(lib.crate_types), new Set(['staticlib', 'cdylib', 'rlib'])); } }
  assert.equal(read('rust-runtime/Cargo.lock').match(/\[\[package\]\]\nname = "bilikara_runtime"\nversion = "([^"]+)"/)[1], expected);
  assert.equal(JSON.parse(read('package.json')).version, expected); const lock = JSON.parse(read('package-lock.json')); assert.equal(lock.version, expected); assert.equal(lock.packages[''].version, expected);
  const main = read('src-tauri/src/main.rs'); includes(main, ['bilikara_app::run();', 'windows_subsystem = "windows"']); excludes(main, ['backend_process::launch']);
  const source = read('src-tauri/src/lib.rs'); for (const module of ['backend_download', 'backend_process', 'desktop', 'desktop_diagnostics', 'platform', 'presentation', 'window_lifecycle']) includes(source, [`#[cfg(desktop)]\nmod ${module};`]); includes(source, ['desktop::run();']); includes(read('src-tauri/src/desktop.rs'), ['pub(crate) fn run()', 'desktop_import::gate_startup(app, window, startup_log)', '.on_window_event(window_lifecycle::handle_window_event)']);
});
