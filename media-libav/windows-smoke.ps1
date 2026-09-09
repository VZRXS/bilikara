# Run from any directory after extracting the preview package. No Python/MSYS2 needed.
$ErrorActionPreference = 'Stop'
$backend = Join-Path $PSScriptRoot 'bilikara.exe'
if (-not (Test-Path $backend)) { throw 'Extract the complete preview package first' }
$previousHome = $env:BILIKARA_HOME
$previewHome = Join-Path $env:TEMP ('Bilikara preview bootstrap ' + [guid]::NewGuid())
$env:BILIKARA_HOME = $previewHome
try {
    $child = Start-Process -FilePath $backend -ArgumentList @('--tool-smoke', 'windows-libav-preview') -PassThru
    $null = $child.Handle # Retain the handle so ExitCode remains available after exit.
    if (-not $child.WaitForExit(900000)) {
        $child.Kill($true)
        throw 'Preview smoke timed out after 15 minutes; see libav-smoke-result.json'
    }
    if ($child.ExitCode -ne 0) { throw "Preview smoke failed (exit $($child.ExitCode)); see libav-smoke-result.json" }
    $result = Get-Content (Join-Path $PSScriptRoot 'libav-smoke-result.json') -Raw | ConvertFrom-Json
    if ($result.outcome -ne 'success') { throw 'Preview smoke did not succeed' }
    Write-Output 'Windows x64 synthetic artifact smoke succeeded; real-device manual checks remain separate.'
} finally {
    if (Test-Path $previewHome) { Remove-Item $previewHome -Recurse -Force }
    $env:BILIKARA_HOME = $previousHome
}
