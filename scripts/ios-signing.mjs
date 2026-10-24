// Optional official iOS Ad Hoc distribution. Tauri owns certificate import and
// temporary keychain lifetime; this gate checks the profile and final seal.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const config=JSON.parse(readFileSync(path.join(root,'src-tauri/tauri.conf.json'),'utf8'));
const ios=JSON.parse(readFileSync(path.join(root,'src-tauri/tauri.ios.conf.json'),'utf8'));
const bundleId=ios.identifier ?? config.identifier;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const profilesDirectory=()=>path.join(homedir(),'Library','MobileDevice','Provisioning Profiles');
function requireSigning(ok,code) { if (!ok) throw Error(code); }

export function validateAdHocProfile(profile, identifier, now=Date.now()/1000) {
  const {teamIds,prefixes,entitlements:ent,expiresAt,deviceCount,allDevices,certificateSha256,platforms}=profile ?? {};
  requireSigning(Array.isArray(teamIds) && teamIds.length===1 && /^[A-Z0-9]{10}$/.test(teamIds[0]),'ios_profile_team');
  requireSigning(Array.isArray(prefixes) && prefixes.length===1 && /^[A-Z0-9]{10}$/.test(prefixes[0]),'ios_profile_prefix');
  requireSigning(Array.isArray(platforms) && platforms.includes('iOS') && allDevices===false && Number.isSafeInteger(deviceCount) && deviceCount>0,'ios_profile_not_adhoc');
  requireSigning(Number.isFinite(expiresAt) && expiresAt>now,'ios_profile_expired');
  requireSigning(ent?.['application-identifier']===`${prefixes[0]}.${identifier}` && ent?.['com.apple.developer.team-identifier']===teamIds[0],'ios_profile_identifier');
  requireSigning(ent?.['get-task-allow']===false,'ios_profile_not_distribution');
  requireSigning(Array.isArray(certificateSha256) && certificateSha256.length>0 && certificateSha256.every(value=>/^[a-f0-9]{64}$/.test(value)),'ios_profile_certificate');
  return {teamId:teamIds[0],applicationIdentifier:ent['application-identifier'],deviceCount,expiresAt,certificateSha256};
}

export function validateSignedEntitlements(ent, profile) {
  requireSigning(ent?.['application-identifier']===profile.applicationIdentifier && ent?.['com.apple.developer.team-identifier']===profile.teamId && ent?.['get-task-allow']===false,'ios_signed_entitlements');
}

function command(executable,args,timeout=30000) {
  const result=spawnSync(executable,args,{cwd:root,encoding:'utf8',timeout,maxBuffer:4*1024*1024});
  // Tool output can contain profile contents or private paths. Keep failures
  // fixed; normal build diagnostics still come from Tauri's build command.
  requireSigning(!result.error && result.status===0,`ios_signing_tool_failed:${path.basename(executable)}`);
  return result.stdout.trim();
}
function decode(value,code) {
  requireSigning(typeof value==='string' && value.length>0 && value.length<16*1024*1024,code);
  const compact=value.replace(/\s/g,'');
  requireSigning(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact),code);
  const bytes=Buffer.from(compact,'base64');requireSigning(bytes.length>0,code);return bytes;
}
function inspectPlist(mode,file) {
  return JSON.parse(command('xcrun',['swift',path.join(root,'scripts/ios-profile.swift'),mode,file],120000));
}
function inspectProfile(file,temporary) {
  const plist=path.join(temporary,'profile.plist');
  writeFileSync(plist,command('security',['cms','-D','-i',file]),{mode:0o600,encoding:'utf8'});
  return validateAdHocProfile(inspectPlist('profile',plist),bundleId);
}
function withTemporary(operation) {
  const temporary=mkdtempSync(path.join(tmpdir(),'bilikara-ios-signing-'));
  try { return operation(temporary); } finally { rmSync(temporary,{recursive:true,force:true}); }
}
function preflight(receipt) {
  const certificate=decode(process.env.IOS_CERTIFICATE,'ios_certificate_missing_or_invalid');
  requireSigning(certificate.length>0 && Boolean(process.env.IOS_CERTIFICATE_PASSWORD),'ios_certificate_password_missing');
  const bytes=decode(process.env.IOS_MOBILE_PROVISION,'ios_profile_missing_or_invalid');
  return withTemporary(temporary=>{
    const file=path.join(temporary,'input.mobileprovision');writeFileSync(file,bytes,{mode:0o600});
    const profile=inspectProfile(file,temporary);
    const directory=profilesDirectory();
    const existingProfiles=existsSync(directory)?readdirSync(directory):[];
    writeFileSync(receipt,JSON.stringify({...profile,profileSha256:hash(bytes),existingProfiles}),{mode:0o600,flag:'wx',encoding:'utf8'});
    if (process.env.GITHUB_ACTIONS==='true' && process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV,`APPLE_DEVELOPMENT_TEAM=${profile.teamId}\n`,'utf8');
    return {signing:'adhoc-profile-checked',deviceCount:profile.deviceCount,expiresAt:profile.expiresAt};
  });
}
export function cleanupAdHocProfiles(directory,expected) {
  requireSigning(Array.isArray(expected.existingProfiles) && /^[a-f0-9]{64}$/.test(expected.profileSha256),'ios_cleanup_receipt_invalid');
  if (existsSync(directory)) for(const name of readdirSync(directory)) {
    // Tauri 2.11 installs a randomly named profile but does not remove it.
    // Only remove this invocation's new, exact-byte copy; preserve all prior
    // profiles and never remove the system profile directory itself.
    if (!/^[A-Za-z0-9]{16}\.mobileprovision$/.test(name) || expected.existingProfiles.includes(name)) continue;
    const file=path.join(directory,name),stat=lstatSync(file);
    if (stat.isFile() && stat.size<16*1024*1024 && hash(readFileSync(file))===expected.profileSha256) rmSync(file);
  }
}
function cleanup(receipt) {
  if (!existsSync(receipt)) return {cleanup:'no-receipt'};
  cleanupAdHocProfiles(profilesDirectory(),JSON.parse(readFileSync(receipt,'utf8')));
  rmSync(receipt);return {cleanup:'completed'};
}
function verify(ipa,receipt,stage) {
  const expected=JSON.parse(readFileSync(receipt,'utf8'));
  requireSigning(lstatSync(ipa).isFile() && lstatSync(ipa).size<1024*1024*1024,'ios_ipa_invalid');
  return withTemporary(temporary=>{
    command('ditto',['-x','-k',ipa,temporary],120000);
    const app=path.join(temporary,'Payload',`${ios.productName ?? config.productName}.app`);
    requireSigning(lstatSync(app).isDirectory() && !lstatSync(app).isSymbolicLink(),'ios_app_invalid');
    const embedded=path.join(app,'embedded.mobileprovision');
    requireSigning(hash(readFileSync(embedded))===expected.profileSha256,'ios_profile_replaced');
    const profile=inspectProfile(embedded,temporary);
    requireSigning(profile.teamId===expected.teamId,'ios_profile_team_changed');
    const info=key=>command('/usr/libexec/PlistBuddy',['-c',`Print :${key}`,path.join(app,'Info.plist')]);
    requireSigning(info('CFBundleIdentifier')===bundleId && info('NSAppTransportSecurity:NSAllowsArbitraryLoads')==='false','ios_bundle_identity_or_ats');
    const executable=info('CFBundleExecutable');
    requireSigning(executable.length>0 && !/[\\/]/.test(executable) && !['.','..'].includes(executable),'ios_executable_invalid');
    requireSigning(command('xcrun',['lipo','-archs',path.join(app,executable)])==='arm64','ios_architecture');
    const platforms=[...command('xcrun',['vtool','-show-build',path.join(app,executable)]).matchAll(/^\s*platform\s+(\S+)/gm)].map(match=>match[1]);
    requireSigning(platforms.length===1 && platforms[0]==='IOS','ios_device_platform');
    command('codesign',['--verify','--deep','--strict',app]);
    const entitlements=path.join(temporary,'entitlements.plist');
    writeFileSync(entitlements,command('codesign',['--display','--entitlements','-', '--xml',app]),{mode:0o600,encoding:'utf8'});
    validateSignedEntitlements(inspectPlist('entitlements',entitlements).entitlements,profile);
    const certPrefix=path.join(temporary,'signer');
    command('codesign',['--display','--extract-certificates',certPrefix,app]);
    const leaf=readFileSync(`${certPrefix}0`);
    requireSigning(profile.certificateSha256.includes(hash(leaf)),'ios_signer_not_in_profile');
    const subject=command('openssl',['x509','-inform','DER','-in',`${certPrefix}0`,'-noout','-subject']);
    requireSigning(/(?:Apple Distribution|iPhone Distribution):/.test(subject),'ios_signer_not_distribution');
    mkdirSync(stage,{recursive:false});
    const name='bilikara-ios-device-arm64-adhoc.ipa';
    copyFileSync(ipa,path.join(stage,name));
    const digest=hash(readFileSync(path.join(stage,name)));
    writeFileSync(path.join(stage,'SHA256SUMS'),`${digest}  ${name}\n`,'utf8');
    const result={schema_version:1,commit:process.env.GITHUB_SHA ?? null,bundleId,signing:'apple-adhoc',architecture:'arm64',
      sha256:digest,profileExpiresAt:profile.expiresAt,registeredDeviceCount:profile.deviceCount,
      xcode:command('xcodebuild',['-version']),rust:command('rustc',['--version']),node:process.version,
      installation:'not_tested',playback:'unverified'};
    writeFileSync(path.join(stage,'build-info.json'),JSON.stringify(result,null,2),'utf8');
    return {signing:result.signing,sha256:digest,installation:result.installation};
  });
}
function main() {
  try {
    requireSigning(process.platform==='darwin','iOS signing requires macOS with Xcode');
    const [action,...args]=process.argv.slice(2);
    requireSigning((['preflight','cleanup'].includes(action) && args.length===1) || (action==='verify' && args.length===3),'Usage: ios-signing.mjs preflight RECEIPT | verify IPA RECEIPT STAGE | cleanup RECEIPT');
    console.log(JSON.stringify(action==='preflight' ? preflight(...args) : action==='cleanup' ? cleanup(...args) : verify(...args)));
  } catch (error) { console.error(error.message.startsWith('ios_') || error.message.startsWith('iOS ') || error.message.startsWith('Usage:') ? error.message : 'ios_signing_failed');process.exitCode=1; }
}
if (process.argv[1] && fileURLToPath(import.meta.url)===path.resolve(process.argv[1])) main();
