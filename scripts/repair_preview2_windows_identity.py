"""Repair only the two version records in the known preview.2 Windows archives.

The original CI compiled the tagged source, but MSVC's implicit .lib/.exp files
made its checkout look dirty. Pinned archive hashes keep this recovery confined
to those two products; every other archive entry must remain byte-identical.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
from pathlib import Path
import zipfile

TAG = "v0.8.0-preview.2"
COMMIT = "a68e882a26b15222fcf1e1e241616ea678d6ebe7"
ORIGINAL_SHA256 = {
    "x64": "026f1bf0454f44ddc2dac4e39eca0dd2f78c7378df481de36a31041b1ef55a35",
    "arm64": "5f832e8b82875d2f86ce6eed48a03990d65c34e15de9230942e82d80e6e7a471",
}
RECORDS = ("bilikara/_internal/APP_VERSION", "bilikara/_internal/native-desktop.json")


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def repair(source: Path, output: Path, arch: str) -> dict:
    original_hash = sha256(source)
    if original_hash != ORIGINAL_SHA256[arch]:
        raise ValueError("Not the known original preview.2 archive; refusing to rewrite it")
    old = f"{TAG}-g{COMMIT[:12]}-dirty"
    with zipfile.ZipFile(source) as before:
        names = before.namelist()
        if len(names) != len(set(names)) or not all(name in names for name in RECORDS):
            raise ValueError("Missing or duplicate archive entries")
        facts = json.loads(before.read(RECORDS[1]).decode("utf-8"))
        if (facts.get("version") != old or facts.get("arch") != arch
                or facts.get("platform") != "windows" or facts.get("backend") != "rust"
                or facts.get("schema_version") != 1 or facts.get("development") is not False):
            raise ValueError("Unexpected package identity")
        if before.read(RECORDS[0]).decode("utf-8").strip() != old:
            raise ValueError("Version records disagree")
        replacements = {}
        for name in RECORDS:
            data = before.read(name)
            if data.count(old.encode("utf-8")) != 1:
                raise ValueError("Ambiguous version record")
            replacements[name] = data.replace(old.encode("utf-8"), TAG.encode("utf-8"))
        output.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(output, "x") as after:
            for entry in before.infolist():
                after.writestr(copy.copy(entry), replacements.get(entry.filename, before.read(entry)))
        with zipfile.ZipFile(output) as after:
            if after.namelist() != names:
                raise ValueError("Archive entry list changed")
            for name in names:
                expected = replacements[name] if name in replacements else before.read(name)
                if after.read(name) != expected:
                    raise ValueError(f"Unexpected content change: {name}")
    return {"tag": TAG, "source_commit": COMMIT, "arch": arch,
            "old_version": old, "version": TAG, "changed_entries": list(RECORDS),
            "other_entries_byte_identical": True,
            "original_sha256": original_hash, "repaired_sha256": sha256(output)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--arch", choices=ORIGINAL_SHA256, required=True)
    args = parser.parse_args()
    print(json.dumps(repair(args.source, args.output, args.arch), indent=2))
