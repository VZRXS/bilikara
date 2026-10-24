// Provisioning policy and real Apple plist parsing are separate from signing
// with Apple-issued credentials. No fixture qualifies device installation.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {cleanupAdHocProfiles, validateAdHocProfile, validateSignedEntitlements} from '../scripts/ios-signing.mjs';

const identifier='com.bilikara.desktop';
const now=1000;
const good=()=>({teamIds:['ABCDE12345'],prefixes:['PREFIX1234'],platforms:['iOS'],allDevices:false,
  deviceCount:2,expiresAt:2000,certificateSha256:['a'.repeat(64)],
  entitlements:{'application-identifier':`PREFIX1234.${identifier}`,'com.apple.developer.team-identifier':'ABCDE12345','get-task-allow':false}});
test('Ad Hoc requires explicit app identity, unexpired distribution profile and registered devices',()=>{
  const result=validateAdHocProfile(good(),identifier,now);
  assert.equal(result.teamId,'ABCDE12345');
  assert.equal(result.applicationIdentifier,`PREFIX1234.${identifier}`,'Legacy App ID prefix need not equal team ID');
  for (const change of [
    p=>p.deviceCount=0,p=>p.allDevices=true,p=>p.platforms=['OSX'],p=>p.expiresAt=now,
    p=>p.teamIds=['OTHER12345'],p=>p.prefixes=['OTHER12345'],p=>p.certificateSha256=[],
    p=>p.entitlements['application-identifier']='PREFIX1234.*',
    p=>p.entitlements['get-task-allow']=true,p=>delete p.entitlements['get-task-allow'],
  ]) {const profile=good();change(profile);assert.throws(()=>validateAdHocProfile(profile,identifier,now),/^Error: ios_profile_/);}
  const universal=good();universal.deviceCount=200;
  assert.equal(validateAdHocProfile(universal,identifier,now).deviceCount,200,'Device categories do not impose one combined 100-device limit');
});
test('final signed entitlements retain application/team identity and disallow debugger access',()=>{
  const profile=validateAdHocProfile(good(),identifier,now);
  validateSignedEntitlements(good().entitlements,profile);
  for (const ent of [null,{}, {...good().entitlements,'get-task-allow':true},
    {...good().entitlements,'application-identifier':'PREFIX1234.other'},
    {...good().entitlements,'com.apple.developer.team-identifier':'OTHER12345'}]) {
    assert.throws(()=>validateSignedEntitlements(ent,profile),/ios_signed_entitlements/);
  }
});
test('provisioning cleanup deletes only new exact-byte Tauri copies and preserves prior/unrelated/link entries',()=>{
  const home=mkdtempSync(path.join(tmpdir(),'bilikara-ios-profile 中文 & '));
  try {
    const names={prior:'AAAAAAAAAAAAAAAA.mobileprovision',fresh:'BBBBBBBBBBBBBBBB.mobileprovision',other:'CCCCCCCCCCCCCCCC.mobileprovision',
      link:'DDDDDDDDDDDDDDDD.mobileprovision',manual:'manual.mobileprovision'};
    for(const [role,name] of Object.entries(names)) if(role!=='link') writeFileSync(path.join(home,name),role==='other'?'unrelated':'owned-profile');
    if(process.platform!=='win32') symlinkSync(names.prior,path.join(home,names.link));
    const profileSha256=createHash('sha256').update('owned-profile').digest('hex');
    cleanupAdHocProfiles(home,{profileSha256,existingProfiles:[names.prior]});
    assert.equal(existsSync(path.join(home,names.fresh)),false);
    for(const role of ['prior','other','manual']) assert.equal(existsSync(path.join(home,names[role])),true);
    if(process.platform!=='win32') assert.equal(existsSync(path.join(home,names.link)),true);
    assert.throws(()=>cleanupAdHocProfiles(home,{profileSha256:'wrong',existingProfiles:[]}),/ios_cleanup_receipt_invalid/);
  } finally {rmSync(home,{recursive:true,force:true});}
});
test('real Foundation plist inspector handles dates/certificates without exposing device IDs',{
  skip:process.platform!=='darwin' && 'Requires Apple Foundation/CryptoKit and Xcode; policy fixtures do not replace this check',timeout:120000,
},()=>{
  const home=mkdtempSync(path.join(tmpdir(),'bilikara-ios-profile-test-'));
  try {
    const plist=path.join(home,'profile.plist');
    writeFileSync(plist,`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
      <key>TeamIdentifier</key><array><string>ABCDE12345</string></array>
      <key>ApplicationIdentifierPrefix</key><array><string>PREFIX1234</string></array>
      <key>Platform</key><array><string>iOS</string></array>
      <key>ExpirationDate</key><date>2030-01-01T00:00:00Z</date>
      <key>ProvisionedDevices</key><array><string>PRIVATE-DEVICE-ONE</string><string>PRIVATE-DEVICE-TWO</string></array>
      <key>DeveloperCertificates</key><array><data>Y2VydGlmaWNhdGU=</data></array>
      <key>Entitlements</key><dict><key>application-identifier</key><string>PREFIX1234.${identifier}</string>
      <key>com.apple.developer.team-identifier</key><string>ABCDE12345</string><key>get-task-allow</key><false/></dict>
      </dict></plist>`,'utf8');
    const result=spawnSync('xcrun',['swift',fileURLToPath(new URL('../scripts/ios-profile.swift',import.meta.url)),'profile',plist],
      {encoding:'utf8',timeout:110000,maxBuffer:1024*1024});
    assert.equal(result.status,0,result.stderr);
    assert.doesNotMatch(result.stdout,/PRIVATE-DEVICE/);
    const parsed=JSON.parse(result.stdout);
    assert.equal(parsed.expiresAt,Date.parse('2030-01-01T00:00:00Z')/1000);
    assert.deepEqual(parsed.certificateSha256,[createHash('sha256').update('certificate').digest('hex')]);
    assert.equal(validateAdHocProfile(parsed,identifier,now).deviceCount,2);
  } finally {rmSync(home,{recursive:true,force:true});}
});
test('Ad Hoc is opt-in and credentials never enter PR/default unsigned or simulator jobs',()=>{
  const read=file=>readFileSync(new URL(`../${file}`,import.meta.url),'utf8');
  const caller=read('.github/workflows/ci-bundle.yml'),mobile=read('.github/workflows/mobile.yml');
  assert.match(caller,/ios_adhoc:[\s\S]*?type: boolean\s+default: false/);
  for (const secret of ['IOS_CERTIFICATE','IOS_CERTIFICATE_PASSWORD','IOS_MOBILE_PROVISION']) {
    assert.ok(caller.includes(`${secret}: \${{ github.event_name == 'workflow_dispatch' && inputs.ios_adhoc && secrets.${secret} || '' }}`));
  }
  const [unsigned,signed]=mobile.split('\n  ios-adhoc:\n');
  assert.doesNotMatch(unsigned.split('\njobs:\n')[1],/secrets\.IOS_|IOS_CERTIFICATE|IOS_MOBILE_PROVISION/);
  assert.match(signed,/inputs\.ios_adhoc && github.event_name == 'workflow_dispatch'/);
  assert.match(signed,/github.repository == 'VZRXS\/bilikara' && startsWith\(github.ref, 'refs\/heads\/'\)/);
  assert.match(signed,/needs: test/);
  assert.match(signed,/build --target aarch64 --export-method release-testing --ci/);
  assert.doesNotMatch(signed,/--no-sign|action-gh-release|refs\/tags\/v/);
  assert.ok(signed.indexOf('ios-signing.mjs preflight')<signed.indexOf('ios.mjs build'));
  assert.ok(signed.indexOf('ios-signing.mjs verify')<signed.indexOf('actions/upload-artifact'));
  assert.match(signed,/retention-days: 7/);
  const gate=read('scripts/ios-signing.mjs');
  for(const invariant of ['ios_profile_replaced','ios_signer_not_in_profile','ios_device_platform','--verify','--deep','--strict','ios_signed_entitlements']) assert.ok(gate.includes(invariant));
  assert.doesNotMatch(gate,/--sign.*['"]-['"]|rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED/);
});
