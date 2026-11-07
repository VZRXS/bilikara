"""Bounded, read-only IPA verification for release transport (not app code).

No extraction onto archive-controlled paths. The sole output is the original
IPA byte stream, written exclusively after all outer/inner entries pass.
"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import plistlib
import re
import stat
import struct
import tempfile
import zipfile


def require(condition, message):
    if not condition:
        raise ValueError(message)


def checked_zip(source, limit, count):
    archive = zipfile.ZipFile(source)
    entries = archive.infolist()
    require(0 < len(entries) <= count, 'Unexpected ZIP entry count')
    names = set()
    total = 0
    for entry in entries:
        name = entry.filename
        require(name and name == entry.orig_filename and '\\' not in name
                and not re.search(r'[\x00-\x1f\x7f:]', name)
                and not name.startswith('/')
                and all(part not in ('', '.', '..') for part in name.rstrip('/').split('/')),
                'Unsafe ZIP path')
        require(name.casefold() not in names, 'Duplicate ZIP path')
        names.add(name.casefold())
        mode = entry.external_attr >> 16
        require(stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR), 'Unsafe ZIP entry type')
        require(not entry.flag_bits & 1 and entry.compress_type in (0, 8), 'Unsupported ZIP entry')
        total += entry.file_size
        require(total <= limit and entry.file_size <= limit, 'ZIP expansion limit')
        require(entry.file_size <= max(1024 * 1024, entry.compress_size * 1000), 'ZIP expansion ratio')
        # Reading every member also verifies CRCs and local/central-name agreement.
        with archive.open(entry) as stream:
            size = 0
            while block := stream.read(1024 * 1024):
                size += len(block)
                require(size <= entry.file_size, 'ZIP entry size overflow')
            require(size == entry.file_size, 'ZIP entry size mismatch')
    return archive


def macho(data):
    require(len(data) >= 32, 'Truncated Mach-O')
    magic, cpu, _, filetype, commands, length, _, _ = struct.unpack_from('<8I', data)
    require(magic == 0xfeedfacf and cpu == 0x100000c and filetype == 2,
            'Expected thin ARM64 Mach-O executable')
    require(commands <= 1000 and 32 + length <= len(data), 'Invalid Mach-O commands')
    offset = 32
    platforms = []
    for _ in range(commands):
        require(offset + 8 <= 32 + length, 'Truncated Mach-O command')
        command, size = struct.unpack_from('<2I', data, offset)
        require(size >= 8 and offset + size <= 32 + length, 'Invalid Mach-O command size')
        require(command != 0x1d, 'IPA executable has a code signature')
        if command == 0x32:
            require(size >= 24, 'Truncated build platform')
            platforms.append(struct.unpack_from('<I', data, offset + 8)[0])
        offset += size
    require(offset == 32 + length and platforms == [2], 'Expected iOS device platform, not Simulator')


def verify(source, sha, run_id, version, identifier, output=None, envelope=True):
    require(re.fullmatch('[a-f0-9]{40}', sha) and str(run_id).isdigit() and int(run_id) > 0, 'Invalid provenance')
    with tempfile.TemporaryDirectory(prefix='bilikara-ipa-verify-') as temporary:
        ipa = Path(source)
        if envelope:
            outer = checked_zip(source, 1024 ** 3, 16)
            expected = {'bilikara-ios-device-arm64-unsigned.ipa', 'build-info.txt',
                        'SHA256SUMS', 'system-frameworks.txt', 'build-platform.txt'}
            require(set(outer.namelist()) == expected, 'Unexpected iOS artifact contents')
            info = outer.read('build-info.txt').decode('utf-8')
            for field in (f'commit={sha}', f'run_id={run_id}', 'rust_target=aarch64-apple-ios',
                          'artifact_kind=device-arm64-unsigned', 'signing=unsigned'):
                require(info.splitlines().count(field) == 1, 'iOS build provenance mismatch: ' + field)
            ipa = Path(temporary) / 'original.ipa'
            with outer.open('bilikara-ios-device-arm64-unsigned.ipa') as stream, ipa.open('xb') as dest:
                while block := stream.read(1024 * 1024):
                    dest.write(block)
            with ipa.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            require(outer.read('SHA256SUMS').decode('ascii') ==
                    f'{digest}  bilikara-ios-device-arm64-unsigned.ipa\n', 'IPA checksum mismatch')
            outer.close()
        inner = checked_zip(ipa, 2 * 1024 ** 3, 20000)
        names = inner.namelist()
        apps = {PurePosixPath(name).parts[1] for name in names
                if len(PurePosixPath(name).parts) >= 2 and name.startswith('Payload/')}
        require(len(apps) == 1 and next(iter(apps)).endswith('.app'), 'Expected exactly one Payload app')
        app = 'Payload/' + next(iter(apps)) + '/'
        require(all(name == 'Payload/' or name.startswith(app) for name in names), 'Unexpected IPA payload')
        require(not any(name.endswith('embedded.mobileprovision') or '_CodeSignature' in PurePosixPath(name).parts
                        for name in names), 'IPA contains signing/provisioning material')
        plist_bytes = inner.read(app + 'Info.plist')
        require(len(plist_bytes) <= 1024 * 1024, 'Oversized application plist')
        plist = plistlib.loads(plist_bytes)
        require(plist.get('CFBundleIdentifier') == identifier and plist.get('CFBundleShortVersionString') == version,
                'IPA version/package identity mismatch')
        require(plist.get('CFBundlePackageType') == 'APPL' and plist.get('CFBundleSupportedPlatforms') == ['iPhoneOS'],
                'IPA is not an iPhoneOS application')
        executable = plist.get('CFBundleExecutable', '')
        require(re.fullmatch(r'[A-Za-z0-9_.-]+', executable) and executable not in ('.', '..'), 'Unsafe executable name')
        macho(inner.read(app + executable))
        require(app + 'Assets.car' in names, 'Missing compiled icon assets')
        require(any(name.startswith(app + 'AppIcon') and name.endswith('.png') for name in names), 'Missing icon PNG')
        inner.close()
        size = ipa.stat().st_size
        with ipa.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        receipt = dict(sha=sha, run_id=int(run_id), identifier=identifier, version=version,
                       architecture='arm64', platform='iOS', signing='unsigned', size=size, digest='sha256:' + digest)
        if output:
            with ipa.open('rb') as stream, Path(output).open('xb') as dest:
                while block := stream.read(1024 * 1024):
                    dest.write(block)
        return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source')
    parser.add_argument('--sha', required=True)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--identifier', required=True)
    parser.add_argument('--output')
    parser.add_argument('--ipa', action='store_true', help='Verify a direct IPA instead of its Actions envelope')
    args = parser.parse_args()
    print(json.dumps(verify(args.source, args.sha, args.run_id, args.version, args.identifier, args.output, not args.ipa)))
