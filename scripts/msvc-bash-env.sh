# Git Bash prepends its own link.exe even after VsDevCmd initialized PATH.
# BASH_ENV runs after that startup path setup, before each noninteractive step.
if [ -z "${VCToolsInstallDir-}" ] || [ -z "${VSCMD_ARG_HOST_ARCH-}" ] || [ -z "${VSCMD_ARG_TGT_ARCH-}" ]; then
  printf '%s\n' 'Native MSVC environment is required before Bash build steps' >&2
  exit 1
fi
if ! bilikara_msvc_bin="$(cygpath -u "$VCToolsInstallDir")/bin/Host${VSCMD_ARG_HOST_ARCH}/${VSCMD_ARG_TGT_ARCH}"; then
  printf '%s\n' 'Unable to resolve the selected MSVC tool directory' >&2
  exit 1
fi
if [ ! -f "$bilikara_msvc_bin/link.exe" ] || [ ! -f "$bilikara_msvc_bin/cl.exe" ]; then
  printf '%s\n' 'Selected native MSVC compiler/linker are unavailable' >&2
  exit 1
fi
export PATH="$bilikara_msvc_bin:$PATH"
unset bilikara_msvc_bin
