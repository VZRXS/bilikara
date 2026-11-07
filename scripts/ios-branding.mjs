// iOS build assets only. This does not change app identity, data or signing.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFileSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {pngRgba} from './png-rgba.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iconDirectory = 'src-tauri/icons/ios';
const assetDirectory = 'src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset';
const sourceFile = 'static/pic/icon.png';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const requireBrand = (condition, code) => {if (!condition) throw Error(code);};
const json = file => JSON.parse(readFileSync(file, 'utf8'));

// The pinned Tauri asset catalog uses these phone/tablet/marketing slots.
export const iconSlots = [
  ...[['20x20', [2, 3]], ['29x29', [2, 3]], ['40x40', [2, 3]], ['60x60', [2, 3]]]
    .flatMap(([size, scales]) => scales.map(scale => ({idiom: 'iphone', size, scale: `${scale}x`,
      filename: `AppIcon-${size}@${scale}x${size === '29x29' && scale === 2 ? '-1' : ''}.png`}))),
  ...[['20x20', [1, 2]], ['29x29', [1, 2]], ['40x40', [1, 2]], ['76x76', [1, 2]], ['83.5x83.5', [2]]]
    .flatMap(([size, scales]) => scales.map(scale => ({idiom: 'ipad', size, scale: `${scale}x`,
      filename: `AppIcon-${size}@${scale}x${['20x20', '40x40'].includes(size) && scale === 2 ? '-1' : ''}.png`}))),
  {idiom: 'ios-marketing', size: '1024x1024', scale: '1x', filename: 'AppIcon-512@2x.png'},
];

function regular(file) {
  let stat;
  try {stat = lstatSync(file);}
  catch (error) {if (error.code === 'ENOENT') throw Error('ios_branding_file_missing'); throw error;}
  requireBrand(stat.isFile() && !stat.isSymbolicLink(), 'ios_branding_file_invalid');
  return readFileSync(file);
}
function generatedDirectory(root) {
  let directory = root;
  for (const component of assetDirectory.split('/')) {
    directory = path.join(directory, component);
    let stat;
    try {stat = lstatSync(directory);}
    catch (error) {if (error.code === 'ENOENT') throw Error('ios_branding_project_missing: run npm run ios:init'); throw error;}
    requireBrand(stat.isDirectory() && !stat.isSymbolicLink(), 'ios_icon_directory_invalid');
  }
  return directory;
}
function opaqueIcon(file, size) {
  const image = pngRgba(regular(file));
  requireBrand(image.width === size && image.height === size && image.opaque, 'ios_icon_geometry_or_alpha');
  return image;
}
export function verifyIconSources(root = repository) {
  const receipt = json(path.join(root, iconDirectory, 'branding.json'));
  const declared = json(path.join(root, 'package.json')).devDependencies['@tauri-apps/cli'];
  requireBrand(receipt.schema_version === 1 && receipt.source === sourceFile && receipt.cli === declared
    && receipt.source_sha256 === hash(regular(path.join(root, sourceFile))), 'ios_icon_source_changed');
  const images = new Map();
  for (const slot of iconSlots) {
    const size = Number(slot.size.split('x')[0]) * Number.parseInt(slot.scale, 10);
    const file = path.join(root, iconDirectory, slot.filename);
    requireBrand(receipt.images[slot.filename] === hash(regular(file)), 'ios_icon_asset_changed');
    images.set(slot.filename, opaqueIcon(file, size));
  }
  return images;
}
export function prepareIosBranding(root = repository) {
  const expected = verifyIconSources(root), directory = generatedDirectory(root);
  const contents = json(path.join(directory, 'Contents.json'));
  requireBrand(Array.isArray(contents.images) && contents.images.length === iconSlots.length, 'ios_icon_slots');
  for (const slot of iconSlots) {
    requireBrand(contents.images.filter(image => image.idiom === slot.idiom && image.size === slot.size
      && image.scale === slot.scale && image.filename === slot.filename).length === 1, 'ios_icon_slot_mismatch');
  }
  for (const name of expected.keys()) {
    const destination = path.join(directory, name);
    try {requireBrand(lstatSync(destination).isFile() && !lstatSync(destination).isSymbolicLink(), 'ios_icon_destination_invalid');}
    catch (error) {if (error.code !== 'ENOENT') throw error;}
    copyFileSync(path.join(root, iconDirectory, name), destination);
    requireBrand(hash(regular(destination)) === hash(regular(path.join(root, iconDirectory, name))), 'ios_icon_copy_failed');
  }
  return {source: sourceFile, icons: expected.size};
}

export function configureIosAssetCompilation(root = repository, run = command) {
  const project = path.dirname(path.dirname(generatedDirectory(root)));
  regular(path.join(project, 'project.yml'));
  const spec = path.join(project, 'bilikara-branding.generated.json');
  try {requireBrand(lstatSync(spec).isFile() && !lstatSync(spec).isSymbolicLink(), 'ios_branding_project_settings_invalid');}
  catch (error) {if (error.code !== 'ENOENT') throw error;}
  // Include the complete generated project. Only compiler options are added;
  // identity, sources, frameworks, entitlements and signing stay in project.yml.
  const overrides = {include: ['project.yml'], settings: {base: {
    ASSETCATALOG_OTHER_FLAGS: '$(inherited) --standalone-icon-behavior all',
  }}};
  writeFileSync(spec, JSON.stringify(overrides, null, 2) + '\n', 'utf8');
  run('xcodegen', ['generate', '--spec', spec]);
  return spec;
}

function command(executable, args) {
  const result = spawnSync(executable, args, {cwd: repository, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024});
  requireBrand(!result.error && result.status === 0, 'ios_branding_tool_failed');
  return result.stdout;
}
export function regenerateIosIcons(root = repository) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'bilikara-ios-icons-'));
  try {
    // A temporary sibling has no gen/apple or gen/android: the CLI cannot
    // overwrite the real desktop/Android icons as a side effect.
    const cli = path.join(repository, 'node_modules/@tauri-apps/cli');
    const version = json(path.join(root, 'package.json')).devDependencies['@tauri-apps/cli'];
    requireBrand(json(path.join(cli, 'package.json')).version === version, 'ios_icon_cli_version');
    const output = path.join(temporary, 'icons');
    command(process.execPath, [path.join(cli, 'tauri.js'), 'icon', path.join(root, sourceFile), '--output', output]);
    const receipt = {schema_version: 1, source: sourceFile, source_sha256: hash(regular(path.join(root, sourceFile))), cli: version, images: {}};
    for (const name of readdirSync(path.join(output, 'ios'))) {
      requireBrand(/^AppIcon-[0-9.x]+@[123]x(?:-1)?\.png$/.test(name), 'ios_icon_name');
      const source = path.join(output, 'ios', name);
      const image = pngRgba(regular(source)); requireBrand(image.opaque, 'ios_icon_geometry_or_alpha');
      receipt.images[name] = hash(regular(source));
    }
    for (const slot of iconSlots) requireBrand(receipt.images[slot.filename], 'ios_icon_missing');
    for (const name of Object.keys(receipt.images)) copyFileSync(path.join(output, 'ios', name), path.join(root, iconDirectory, name));
    writeFileSync(path.join(root, iconDirectory, 'branding.json'), JSON.stringify(receipt, null, 2) + '\n', 'utf8');
    verifyIconSources(root);
  } finally {rmSync(temporary, {recursive: true, force: true});}
}

// The final application must retain independent display roles after Xcode's
// plist merge. Checking only the source override cannot establish that.
export function verifyIosScenes(info) {
  const manifest = info.UIApplicationSceneManifest;
  const roles = manifest?.UISceneConfigurations;
  const expected = {UIWindowSceneSessionRoleApplication:'Host',
    UIWindowSceneSessionRoleExternalDisplayNonInteractive:'Audience',
    UIWindowSceneSessionRoleExternalDisplay:'Audience'};
  requireBrand(manifest?.UIApplicationSupportsMultipleScenes === false && roles
    && Object.keys(roles).length === Object.keys(expected).length, 'ios_scene_manifest');
  for (const [role, name] of Object.entries(expected)) {
    const configs = roles[role];
    requireBrand(Array.isArray(configs) && configs.length === 1
      && configs[0].UISceneConfigurationName === name
      && configs[0].UISceneDelegateClassName === 'TaoSceneDelegate', 'ios_scene_role');
  }
}

export function verifyAppInfo(info, identifier) {
  requireBrand(info.CFBundleIdentifier === identifier && info.CFBundleName === 'bilikara'
    && info.CFBundleDisplayName === 'bilikara', 'ios_branding_name_or_identity');
  const primary = info.CFBundleIcons?.CFBundlePrimaryIcon;
  requireBrand(primary?.CFBundleIconName === 'AppIcon' && Array.isArray(primary.CFBundleIconFiles)
    && primary.CFBundleIconFiles.includes('AppIcon60x60'), 'ios_primary_icon');
  const ipad = info['CFBundleIcons~ipad']?.CFBundlePrimaryIcon;
  if (ipad) requireBrand(ipad.CFBundleIconName === 'AppIcon', 'ios_ipad_icon');
}
export function verifyPackagedBranding(app, root = repository) {
  requireBrand(process.platform === 'darwin', 'ios_branding_requires_macos');
  const images = verifyIconSources(root), config = json(path.join(root, 'src-tauri/tauri.conf.json'));
  const ios = json(path.join(root, 'src-tauri/tauri.ios.conf.json'));
  const info = JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Info.plist')]));
  verifyAppInfo(info, ios.identifier ?? config.identifier);
  verifyIosScenes(info);
  try {requireBrand(lstatSync(path.join(app, 'Assets.car')).isFile(), 'ios_icon_catalog_missing');}
  catch (error) {if (error.code === 'ENOENT') throw Error('ios_icon_catalog_missing'); throw error;}
  const temporary = mkdtempSync(path.join(tmpdir(), 'bilikara-ios-icon-check-'));
  try {
    for (const scale of [2, 3]) {
      const expected = images.get(`AppIcon-60x60@${scale}x.png`), output = path.join(temporary, `icon-${scale}.png`);
      const input = path.join(app, `AppIcon60x60@${scale}x.png`);
      regular(input); // sips may report success for a missing input; fail first.
      // sips reads Apple's optimized PNG too; normalize outside the sealed app.
      command('/usr/bin/sips', ['-s', 'format', 'png', input, '--out', output]);
      const actual = opaqueIcon(output, 60 * scale);
      requireBrand(actual.pixels.equals(expected.pixels), 'ios_packaged_icon_mismatch');
    }
  } finally {rmSync(temporary, {recursive: true, force: true});}
  return {display_name: 'bilikara', primary_icon: 'AppIcon', icon_pixels: 'matched'};
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const [action, app] = process.argv.slice(2);
    requireBrand(['generate', 'prepare', 'check', 'verify'].includes(action)
      && (action === 'verify' ? Boolean(app) && process.argv.length === 4 : process.argv.length === 3), 'ios_branding_usage');
    if (action === 'generate') regenerateIosIcons();
    else if (action === 'prepare') prepareIosBranding();
    else if (action === 'verify') verifyPackagedBranding(app);
    else verifyIconSources();
  } catch (error) {console.error(error.message.startsWith('ios_') ? error.message : 'ios_branding_failed'); process.exitCode = 1;}
}
