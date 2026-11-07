"""Synthetic transport-format fixtures, never native build/installation proof."""
import io
import json
import plistlib
import struct
import sys
import zipfile
import hashlib

options = json.load(sys.stdin)
case = options.get('case', '')


def archive(entries):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as dest:
        for name, data in entries:
            entry = zipfile.ZipInfo(name, (2020, 1, 2, 3, 4, 6))
            entry.compress_type = zipfile.ZIP_DEFLATED
            dest.writestr(entry, data)
    return buffer.getvalue()


app = 'Payload/bilikara.app/'
plist = dict(CFBundleIdentifier='com.bilikara.app', CFBundleShortVersionString='0.9.0',
             CFBundleExecutable='bilikara', CFBundlePackageType='APPL', CFBundleSupportedPlatforms=['iPhoneOS'])
if case == 'identity':
    plist['CFBundleIdentifier'] = 'unrelated.application'
if case == 'version':
    plist['CFBundleShortVersionString'] = '0.8.0'
commands = struct.pack('<6I', 0x32, 24, 7 if case == 'simulator' else 2, 0, 0, 0)
if case == 'signed':
    commands += struct.pack('<4I', 0x1d, 16, 0, 0)
binary = struct.pack('<8I', 0xfeedfacf, 0x1000007 if case == 'architecture' else 0x100000c,
                     0, 2, 2 if case == 'signed' else 1, len(commands), 0, 0) + commands
entries = [(app + 'Info.plist', plistlib.dumps(plist, fmt=plistlib.FMT_BINARY)),
           (app + 'bilikara', binary), (app + 'Assets.car', b'fixture asset catalog'),
           (app + 'AppIcon60x60@2x.png', b'fixture icon')]
if case == 'path':
    entries.append(('../outside', b'unsafe'))
if case == 'duplicate':
    entries.append(entries[0])
if case == 'provisioning':
    entries.append((app + 'embedded.mobileprovision', b'profile'))
if case == 'extra-app':
    entries.append(('Payload/Other.app/Info.plist', b'other'))
if case == 'extra-ipa-file':
    entries.append(('unexpected.apk', b'other'))
if case == 'icons':
    entries = entries[:2]
ipa = archive(entries)
if options.get('direct'):
    sys.stdout.buffer.write(ipa)
else:
    sha = options['sha'] if case != 'commit' else 'a' * 40
    run = options['runId'] if case != 'run' else 999
    info = f'commit={sha}\nrun_id={run}\nrust_target=aarch64-apple-ios\nartifact_kind=device-arm64-unsigned\nsigning=unsigned\n'
    digest = hashlib.sha256(ipa).hexdigest() if case != 'checksum' else 'b' * 64
    entries = [('bilikara-ios-device-arm64-unsigned.ipa', ipa), ('build-info.txt', info),
               ('SHA256SUMS', f'{digest}  bilikara-ios-device-arm64-unsigned.ipa\n'),
               ('system-frameworks.txt', 'native evidence'), ('build-platform.txt', 'platform IOS')]
    if case == 'extra-envelope':
        entries.append(('unexpected.ipa', ipa))
    if case == 'outer-path':
        entries.append(('/unsafe', b'bad'))
    sys.stdout.buffer.write(archive(entries))
