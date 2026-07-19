# Rust and Tauri generation policy

## Verified baseline

| Concern | Project baseline |
| --- | --- |
| Rust toolchain used by CI and release builds | `1.97.0` stable, pinned in `rust-toolchain.toml` |
| Rust edition (`rust/`) | 2024 |
| Rust edition (`src-tauri/`) | 2024 |
| Native utility crate MSRV | 1.85 |
| Tauri crate MSRV | 1.88 |
| Effective whole-project Rust MSRV | 1.88 |
| Tauri application generation | v2 |
| Resolved `@tauri-apps/cli` | 2.11.2 |
| Resolved top-level `tauri` crate | 2.11.2 |
| Native C ABI generation | 1 |

Rust 1.97.0 is the current tested compiler baseline because it is an exact,
recent stable release that supports edition 2024 and has passed the native
crate, Tauri crate, Python integration, and Linux bundle validations. The pin
is intentionally reproducible; it does not move whenever the `stable` channel
moves.

The tested compiler and the minimum supported compiler are different
concepts. Edition 2024 sets the native crate's current floor at Rust 1.85. The
locked Tauri dependency graph contains active dependencies that require Rust
1.88, so 1.88 is the Tauri crate and whole-project floor. Both floors have been
checked with their named toolchains. A manifest must only raise its
`rust-version` when its code or resolved supported dependencies actually need
the higher compiler.

## Stable Rust and toolchain changes

Both Rust projects use the root `rust-toolchain.toml`. Nightly, beta, unstable
features, and unreviewed dependency Git revisions are outside the supported
release baseline.

Advance the pinned compiler only when at least one of these applies:

- a major Bilikara release is being prepared;
- a scheduled dependency-maintenance review is in progress;
- a dependency requires a newer stable compiler;
- a relevant compiler bug or security fix is needed;
- the existing baseline is no longer reasonably current.

A toolchain change is a dedicated, reviewed change. It must run both locked
Rust suites, Python tests, the direct-native release gate, and the Tauri bundle
build before becoming the baseline. Do not set the MSRV equal to the selected
compiler merely to make the two numbers match.

## Tauri v2 compatibility

Tauri v2 is the required desktop framework generation. Manifests and source
must not add Tauri v1 compatibility branches, v1 allowlist configuration, or v1
plugin packages. Production builds must not use Tauri v3 prereleases.

The manifests express compatible Tauri v2 ranges. Cargo may correctly resolve
different compatible v2 releases for `tauri`, `tauri-build`, `tauri-utils`,
`tauri-runtime`, `tauri-runtime-wry`, `tauri-macros`, and `tauri-codegen`.
Those internal crates have different release cadences and must not be forced to
share the top-level crate's patch number.

Do not update Tauri solely because a newer patch exists. Review a compatible
v2 update when:

1. a security advisory affects the project;
2. a relevant Tauri bug is fixed;
3. an application feature requires it;
4. a supported platform build is broken;
5. scheduled dependency maintenance is underway; or
6. a project release is refreshing its supported baseline.

The currently resolved Tauri v2 dependencies are intentionally retained for
this milestone because no applicable security, feature, bug, or platform-build
reason requires dependency churn.

## Lockfiles and reproducible builds

The following lockfiles are committed release inputs:

```text
rust/Cargo.lock
src-tauri/Cargo.lock
package-lock.json
```

Manifest ranges describe the supported dependency generation. Lockfiles
describe the exact graph that was tested. Normal CI and release builds use
`cargo ... --locked` and `npm ci`; a locked-build failure must be fixed by an
intentional dependency update rather than silently resolving a different
graph.

Dependency updates must review manifest and lockfile diffs together. Do not
hand-edit an individual transitive package in a Cargo lockfile or regenerate a
lockfile without validating the resulting complete graph.

## Maintenance cadence

- Routine dependency review: every two to three months.
- Release baseline review: before a major application release.
- Security update: immediately after impact and fix verification.
- Required compatibility update: when the relevant need arises.

The project does not use automation that opens a pull request for every patch
release. A maintenance review may group compatible updates, but unrelated
application changes remain separate from dependency-generation changes.

## Promotion and rollback

To promote a new Rust or Tauri baseline:

1. use a dedicated branch and commit;
2. update the toolchain, manifests, and affected lockfiles coherently;
3. inspect the resolved top-level and internal Tauri v2 graph;
4. run locked native and Tauri formatting, Clippy, tests, and release builds;
5. run Python compilation and integration tests;
6. run the direct native ABI/capability gate;
7. run `npm ci` and the locked Tauri bundle build;
8. validate and report every supported target independently.

For rollback, identify the last known-good baseline commit and revert the
baseline change as a coherent unit. Restore `rust-toolchain.toml`, manifests,
lockfiles, and package files together, then rerun all affected locked builds and
the native ABI gate. Do not move an existing release tag; withdraw or replace a
broken release. If the former baseline is affected by a security advisory,
select and validate another fixed Tauri v2 or stable Rust baseline instead of
reintroducing the vulnerable graph.

## Cross-platform release requirements

The current CI test environments are Linux, Windows, and macOS. The release
bundle matrix currently names these desktop targets:

```text
Windows x64
Windows ARM64
macOS ARM64
macOS Intel
```

Linux currently supplies native, Tauri, Python, and bundle build validation;
it is not listed as a published release-bundle target in the workflow. A result
from one operating system or architecture never proves another target passed.

For every published target, CI must:

- use the repository's pinned Rust toolchain;
- use both committed Cargo lockfiles and `package-lock.json`;
- build the target's native `bilikara_rust` dynamic library before Python
  packaging;
- run the direct native release gate without a skip;
- set `BILIKARA_REQUIRE_RUST_LIB=1` for the PyInstaller bundle;
- include the correct `.dll` or `.dylib` in that bundle;
- complete the locked Tauri v2 build for that architecture.

Signing, notarization, installation, launch smoke tests, and runtime tests are
reported separately. Cross-platform compatibility must only be claimed for
platforms that actually completed their applicable validation.
