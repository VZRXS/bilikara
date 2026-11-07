// Actual pinned Tauri generator and filesystem assets. The catalog fixture is
// the independent Tauri CLI 2.11.3 Apple template; no Xcode/device is simulated.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {crc32} from 'node:zlib';
import {pngRgba} from '../scripts/png-rgba.mjs';
import {configureIosAssetCompilation, prepareIosBranding, regenerateIosIcons, verifyAppInfo, verifyIosScenes, verifyIconSources, verifyPackagedBranding} from '../scripts/ios-branding.mjs';
const repository = fileURLToPath(new URL('../', import.meta.url));
const icons = 'src-tauri/icons/ios', catalog = 'src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset';
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'bilikara icons 中文 $() & '));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  for (const relative of [icons, 'static/pic', catalog]) mkdirSync(path.join(root, relative), {recursive: true});
  cpSync(path.join(repository, icons), path.join(root, icons), {recursive: true});
  for (const relative of ['static/pic/icon.png', 'package.json', 'src-tauri/tauri.conf.json', 'src-tauri/tauri.ios.conf.json']) {
    copyFileSync(path.join(repository, relative), path.join(root, relative));
  }
  copyFileSync(new URL('./fixtures/ios/AppIcon-Contents.json', import.meta.url), path.join(root, catalog, 'Contents.json'));
  return root;
}

test('PNG inspection rejects corrupted CRC, oversized geometry, truncation and trailing bytes', () => {
  const original = readFileSync(path.join(repository, icons, 'AppIcon-60x60@2x.png'));
  assert.deepEqual([pngRgba(original).width, pngRgba(original).opaque], [120, true]);
  const corrupt = Buffer.from(original); corrupt[40] ^= 1;
  const oversized = Buffer.from(original); oversized.writeUInt32BE(4097, 16);
  oversized.writeUInt32BE(crc32(oversized.subarray(12, 29)), 29);
  for (const bytes of [corrupt, oversized, original.subarray(0, original.length - 12), Buffer.concat([original, Buffer.from([0])])]) {
    assert.throws(() => pngRgba(bytes), /ios_icon_png_invalid/);
  }
});

test('clean Apple catalog receives all opaque branded slots and repairs regenerated defaults', t => {
  const root = fixture(t), original = readFileSync(path.join(root, catalog, 'Contents.json'));
  assert.equal(verifyIconSources(root).size, 18);
  assert.deepEqual(prepareIosBranding(root), {source: 'static/pic/icon.png', icons: 18});
  const images = JSON.parse(original).images;
  for (const slot of images) {
    const bytes = readFileSync(path.join(root, catalog, slot.filename));
    assert.deepEqual(bytes, readFileSync(path.join(root, icons, slot.filename)));
    const icon = pngRgba(bytes), size = Number(slot.size.split('x')[0]) * Number.parseInt(slot.scale);
    assert.deepEqual([icon.width, icon.height, icon.opaque], [size, size, true]);
  }
  const name = images[0].filename;
  writeFileSync(path.join(root, catalog, name), 'Tauri default regenerated');
  prepareIosBranding(root);
  assert.deepEqual(readFileSync(path.join(root, catalog, name)), readFileSync(path.join(root, icons, name)));
  assert.deepEqual(readFileSync(path.join(root, catalog, 'Contents.json')), original);
});

test('stale source, wrong slot mappings and linked destinations fail before accepting branding', t => {
  const root = fixture(t);
  const source = path.join(root, 'static/pic/icon.png'), bytes = readFileSync(source);
  writeFileSync(source, 'new ungenerated logo');
  assert.throws(() => prepareIosBranding(root), /source_changed/); writeFileSync(source, bytes);
  const file = path.join(root, catalog, 'Contents.json'), original = readFileSync(file), content = JSON.parse(original);
  content.images[0].filename = '../private.png'; writeFileSync(file, JSON.stringify(content));
  assert.throws(() => prepareIosBranding(root), /slot_mismatch/); writeFileSync(file, original);
  const target = path.join(root, catalog, 'AppIcon-20x20@2x.png');
  const unrelated = path.join(root, 'unrelated.png'); writeFileSync(unrelated, 'preserve');
  symlinkSync(unrelated, target);
  assert.throws(() => prepareIosBranding(root), /destination_invalid/);
  assert.equal(readFileSync(unrelated, 'utf8'), 'preserve');
});

test('asset compiler flags belong to the generated Xcode project before any build or seal', t => {
  const root = fixture(t), project = path.join(root, 'src-tauri/gen/apple');
  const original = 'name: Fixture\ntargets: {}\n';
  writeFileSync(path.join(project, 'project.yml'), original, 'utf8');
  const calls = [], spec = configureIosAssetCompilation(root, (...args) => calls.push(args));
  const config = JSON.parse(readFileSync(spec, 'utf8'));
  assert.deepEqual(config.include, ['project.yml']);
  assert.equal(config.settings.base.ASSETCATALOG_OTHER_FLAGS, '$(inherited) --standalone-icon-behavior all');
  assert.deepEqual(calls, [['xcodegen', ['generate', '--spec', spec]]]);
  assert.equal(readFileSync(path.join(project, 'project.yml'), 'utf8'), original);
  rmSync(spec);symlinkSync(path.join(project, 'project.yml'), spec);
  assert.throws(() => configureIosAssetCompilation(root), /project_settings_invalid/);
  assert.equal(readFileSync(path.join(project, 'project.yml'), 'utf8'), original);
});

test('actual Tauri icon generation uses the sole logo and never rewrites desktop/Android project assets', {timeout: 60000}, t => {
  const root = fixture(t), unrelated = path.join(root, 'src-tauri/gen/android/app/src/main/res');
  mkdirSync(unrelated, {recursive: true}); writeFileSync(path.join(unrelated, 'keep'), 'existing Android icon');
  writeFileSync(path.join(root, catalog, 'keep'), 'existing project');
  regenerateIosIcons(root);
  assert.equal(verifyIconSources(root).size, 18);
  assert.equal(readFileSync(path.join(unrelated, 'keep'), 'utf8'), 'existing Android icon');
  assert.equal(readFileSync(path.join(root, catalog, 'keep'), 'utf8'), 'existing project');
  assert.equal(readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'), readFileSync(path.join(repository, 'src-tauri/tauri.conf.json'), 'utf8'));
});

const scenes = {UIApplicationSupportsMultipleScenes:false, UISceneConfigurations:Object.fromEntries([
  ['UIWindowSceneSessionRoleApplication','Host'],['UIWindowSceneSessionRoleExternalDisplayNonInteractive','Audience'],
  ['UIWindowSceneSessionRoleExternalDisplay','Audience'],
].map(([role,name])=>[role,[{UISceneConfigurationName:name,UISceneDelegateClassName:'TaoSceneDelegate'}]]))};
const info = {UIApplicationSceneManifest:scenes, CFBundleIdentifier: 'com.bilikara.app', CFBundleName: 'bilikara', CFBundleDisplayName: 'bilikara',
  CFBundleIcons: {CFBundlePrimaryIcon: {CFBundleIconName: 'AppIcon', CFBundleIconFiles: ['AppIcon60x60']}},
  'CFBundleIcons~ipad': {CFBundlePrimaryIcon: {CFBundleIconName: 'AppIcon'}}};
test('final app identity and primary icon must use the existing bundle ID and bilikara name', () => {
  verifyAppInfo(info, 'com.bilikara.app');
  for (const change of [{CFBundleIdentifier: 'com.other.app'}, {CFBundleName: 'bilikara iOS dev'}, {CFBundleDisplayName: 'Tauri'}, {CFBundleIcons: {}}]) {
    assert.throws(() => verifyAppInfo({...info, ...change}, 'com.bilikara.app'), /ios_/);
  }
  assert.throws(() => verifyAppInfo({...info, CFBundleIcons: {CFBundlePrimaryIcon: {
    CFBundleIconName: 'AppIcon', CFBundleIconFiles: 'AppIcon60x60'}}}, 'com.bilikara.app'), /primary_icon/);
  const config = JSON.parse(readFileSync(path.join(repository, 'src-tauri/tauri.conf.json'), 'utf8'));
  const ios = JSON.parse(readFileSync(path.join(repository, 'src-tauri/tauri.ios.conf.json'), 'utf8'));
  assert.equal(ios.productName ?? config.productName, 'bilikara');
  assert.equal(ios.identifier ?? config.identifier, 'com.bilikara.app');
  const plist = readFileSync(path.join(repository, 'src-tauri/Info.ios.plist'), 'utf8');
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) assert.match(plist, new RegExp(`<key>${key}</key>\\s*<string>bilikara</string>`));
});

test('final app requires one Host scene and both independent external roles, without extra application windows', () => {
  verifyIosScenes(info);
  assert.throws(()=>verifyIosScenes({}),/scene_manifest/);
  const invalid = [
    {...scenes,UIApplicationSupportsMultipleScenes:true},
    {...scenes,UISceneConfigurations:{}},
    {...scenes,UISceneConfigurations:{...scenes.UISceneConfigurations,Other:[]}},
  ];
  for(const change of invalid)assert.throws(()=>verifyIosScenes({UIApplicationSceneManifest:change}),/ios_scene_/);
  for(const role of Object.keys(scenes.UISceneConfigurations)) {
    const configs=structuredClone(scenes);
    configs.UISceneConfigurations[role][0].UISceneDelegateClassName='UnknownDelegate';
    assert.throws(()=>verifyIosScenes({UIApplicationSceneManifest:configs}),/scene_role/);
    configs.UISceneConfigurations[role]=[];
    assert.throws(()=>verifyIosScenes({UIApplicationSceneManifest:configs}),/scene_role/);
  }
});

test('native macOS normalizes compiled icons without modifying the app seal',
  {skip: process.platform !== 'darwin' && 'Requires native plutil/sips; real IPA/device qualification is separate'}, t => {
    const root = fixture(t), app = path.join(root, 'bilikara.app'); mkdirSync(app);
    const plist = path.join(app, 'Info.plist'); writeFileSync(plist, JSON.stringify(info), 'utf8');
    assert.equal(spawnSync('/usr/bin/plutil', ['-convert', 'xml1', plist], {encoding: 'utf8'}).status, 0);
    writeFileSync(path.join(app, 'Assets.car'), 'test-only catalog marker');
    for (const scale of [2, 3]) copyFileSync(path.join(root, icons, `AppIcon-60x60@${scale}x.png`), path.join(app, `AppIcon60x60@${scale}x.png`));
    const original = readFileSync(plist);
    assert.equal(verifyPackagedBranding(app, root).icon_pixels, 'matched');
    assert.deepEqual(readFileSync(plist), original);
    const three = path.join(app, 'AppIcon60x60@3x.png');
    rmSync(three);
    assert.throws(() => verifyPackagedBranding(app, root), /ios_branding_file_missing/);
    copyFileSync(path.join(root, icons, 'AppIcon-60x60@3x.png'), three);
    rmSync(path.join(app, 'Assets.car'));
    assert.throws(() => verifyPackagedBranding(app, root), /ios_icon_catalog_missing/);
    writeFileSync(path.join(app, 'Assets.car'), 'test-only catalog marker');
    assert.equal(spawnSync('/usr/bin/sips', ['--resampleHeightWidth', '120', '120',
      path.join(root, icons, 'AppIcon-20x20@1x.png'), '--out', path.join(app, 'AppIcon60x60@2x.png')], {encoding: 'utf8'}).status, 0);
    assert.throws(() => verifyPackagedBranding(app, root), /packaged_icon_mismatch/);
  });
