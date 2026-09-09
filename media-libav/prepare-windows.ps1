$ErrorActionPreference = 'Stop'
$prefix = $env:BILIKARA_WINDOWS_LIBAV_PREVIEW_PREFIX
if ($env:VSCMD_ARG_TGT_ARCH -ne 'x64') { throw 'Expected native x64 MSVC environment' }
$rustInfo = & rustc -vV
if ($LASTEXITCODE -ne 0 -or -not ($rustInfo -match '^host: x86_64-pc-windows-msvc$')) { throw 'Expected the existing Rust x64 MSVC host target' }
$driver = Join-Path $prefix 'driver'
New-Item -ItemType Directory -Force $driver | Out-Null
cargo build --manifest-path rust-runtime/Cargo.toml --release --locked --example libav_metadata 2>&1 | Tee-Object (Join-Path $prefix "records/driver-build.log")
if ($LASTEXITCODE -ne 0) { throw 'Developer driver build failed' }
Copy-Item rust-runtime/target/release/examples/libav_metadata.exe $driver
$messages = & cargo test --manifest-path rust-runtime/Cargo.toml --release --locked --lib --no-run --message-format=json
$testExit = $LASTEXITCODE
$messages | Out-File (Join-Path $prefix 'records/runtime-test-build.jsonl') -Encoding utf8
if ($testExit -ne 0) { throw 'Runtime smoke test build failed' }
$tests = @($messages | ForEach-Object {
    $record = $_ | ConvertFrom-Json
    if ($record.reason -eq 'compiler-artifact' -and $record.target.name -eq 'bilikara_runtime' -and $record.profile.test -and $record.executable) { $record.executable }
})
if ($tests.Count -ne 1) { throw 'Expected one Runtime library test executable' }
Copy-Item $tests[0] (Join-Path $driver 'libav-runtime-tests.exe')
$redist = @(Get-ChildItem (Join-Path $env:VCToolsRedistDir 'x64/Microsoft.VC*.CRT') -Directory)
if ($redist.Count -ne 1) { throw 'Expected one selected MSVC x64 redistributable directory' }
& (Join-Path $env:pythonLocation 'python.exe') scripts/windows_libav_preview.py collect $prefix $redist[0].FullName (Join-Path $env:SystemRoot 'System32')
if ($LASTEXITCODE -ne 0) { throw 'PE dependency collection failed' }
# Resolve the product terms from this installation's catalog: recent VS
# installers link the EULA rather than installing Licenses/*/license.txt.
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$instances = @(& $vswhere -all -products '*' -format json | ConvertFrom-Json | Where-Object {
    $_.installationPath.TrimEnd([char[]]'\/') -eq $env:VSINSTALLDIR.TrimEnd([char[]]'\/')
})
if ($LASTEXITCODE -ne 0 -or $instances.Count -ne 1) { throw 'Expected the selected Visual Studio instance' }
$instance = $instances[0]
$catalogPath = Join-Path $env:ProgramData "Microsoft/VisualStudio/Packages/_Instances/$($instance.instanceId)/catalog.json"
$catalog = Get-Content -LiteralPath $catalogPath -Raw -Encoding utf8 | ConvertFrom-Json
$licenseUrls = @($catalog.packages | Where-Object { $_.id -eq $instance.productId } |
    ForEach-Object { $_.localizedResources } | Where-Object { $_.language -eq 'en-us' } |
    ForEach-Object { $_.license } | Sort-Object -Unique)
if ($licenseUrls.Count -ne 1 -or $licenseUrls[0] -notmatch '^https://(go\.microsoft\.com|visualstudio\.microsoft\.com)/') {
    throw 'Installed Visual Studio product license URL unavailable'
}
$licenseFile = Join-Path $prefix 'licenses/MSVC-Product-License.html'
Invoke-WebRequest -Uri $licenseUrls[0] -OutFile $licenseFile
if ((Get-Item -LiteralPath $licenseFile).Length -eq 0) { throw 'Empty Visual Studio product license' }
@{
    product_id = $instance.productId
    installation_version = $instance.installationVersion
    license_url = $licenseUrls[0]
} | ConvertTo-Json | Set-Content (Join-Path $prefix 'records/msvc-license-source.json') -Encoding utf8
$redistList = Join-Path $env:VSINSTALLDIR 'Licenses/1033/Redist.txt'
if (-not (Test-Path $redistList)) { throw 'Installed MSVC redistribution list unavailable' }
Copy-Item $redistList (Join-Path $prefix 'licenses/MSVC-Redist.txt')
@(
    'BILIKARA_FFMPEG_SOURCE_VERSION=9.0.1'
    'BILIKARA_FFMPEG_SOURCE_URL=https://ffmpeg.org/releases/ffmpeg-9.0.1.tar.xz'
    "BILIKARA_FFMPEG_SOURCE_ARCHIVE=$prefix/source/ffmpeg-9.0.1.tar.xz"
    "BILIKARA_FFMPEG_LICENSE_FILE=$prefix/licenses/COPYING.LGPLv2.1"
) | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
