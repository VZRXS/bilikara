$ErrorActionPreference = 'Stop'
$prefix = $env:BILIKARA_LIBAV_PREFIX
$arch = $env:VSCMD_ARG_TGT_ARCH
if ($arch -notin @('x64', 'arm64')) { throw 'Expected native x64 or ARM64 MSVC environment' }
$rustArch = if ($arch -eq 'arm64') { 'aarch64' } else { 'x86_64' }
$rustInfo = & rustc -vV
if ($LASTEXITCODE -ne 0 -or -not ($rustInfo -match "^host: $rustArch-pc-windows-msvc$")) { throw 'Expected the matching native Rust MSVC host target' }
$redist = @(Get-ChildItem (Join-Path $env:VCToolsRedistDir "$arch/Microsoft.VC*.CRT") -Directory)
if ($redist.Count -ne 1) { throw 'Expected one selected MSVC redistributable directory' }
& cargo run --manifest-path xtask/Cargo.toml --locked --target host-tuple -- libav-finish --prefix $prefix --redist $redist[0].FullName --system (Join-Path $env:SystemRoot 'System32')
if ($LASTEXITCODE -ne 0) { throw 'Native driver/dependency preparation failed' }
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
