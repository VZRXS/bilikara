"""Compatibility import for retained source Host and package smoke tests.

Native build tooling imports scripts.libav_manifest directly. Keep this path
for existing cache/diagnostic callers without duplicating manifest validation.
"""
from scripts.libav_manifest import MANIFEST, runtime_files

__all__ = ["MANIFEST", "runtime_files"]
