# Use Visual Studio's batch environment initializer on native x64 and ARM64.
# Some installed Launch-VsDevShell.ps1 versions reject an ARM64 host.
param([ValidateSet('x64', 'arm64')][string]$Arch)
$ErrorActionPreference = 'Stop'
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$component = if ($Arch -eq 'arm64') { 'Microsoft.VisualStudio.Component.VC.Tools.ARM64' } else { 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64' }
$installation = & $vswhere -latest -products '*' -requires $component -property installationPath
if ($LASTEXITCODE -ne 0 -or -not $installation) { throw 'Visual Studio C++ tools unavailable' }
$hostArch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'arm64' } else { 'x64' }
$devcmd = Join-Path $installation 'Common7/Tools/VsDevCmd.bat'
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $env:ComSpec
# cmd /s requires the outer quotes; Windows paths cannot contain a quote.
$startInfo.Arguments = '/d /u /s /c "call "' + $devcmd + '" -no_logo -arch=' + $Arch + ' -host_arch=' + $hostArch + ' >nul && set"'
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.StandardOutputEncoding = [System.Text.Encoding]::Unicode
$startInfo.StandardErrorEncoding = [System.Text.Encoding]::Unicode
$process = [System.Diagnostics.Process]::Start($startInfo)
$outputTask = $process.StandardOutput.ReadToEndAsync()
$errorTask = $process.StandardError.ReadToEndAsync()
$process.WaitForExit()
$environmentText = $outputTask.GetAwaiter().GetResult()
$errorText = $errorTask.GetAwaiter().GetResult()
if ($process.ExitCode -ne 0) { throw "MSVC initialization failed: $errorText" }
foreach ($line in ($environmentText -split "`r?`n")) {
    if ($line -notmatch '^([^=]+)=(.*)$') { continue }
    $entryName, $entryValue = $Matches[1], $Matches[2]
    if ([System.Environment]::GetEnvironmentVariable($entryName) -ne $entryValue) {
        [System.Environment]::SetEnvironmentVariable($entryName, $entryValue)
        "$entryName=$entryValue" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
    }
}
if ($env:VSCMD_ARG_TGT_ARCH -ne $Arch -or $env:VSCMD_ARG_HOST_ARCH -ne $hostArch) {
    throw 'MSVC did not initialize the requested native architecture'
}
