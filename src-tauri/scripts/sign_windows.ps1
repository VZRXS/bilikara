param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Path
)

$ErrorActionPreference = "Stop"
$rootScript = Join-Path $PSScriptRoot "..\..\scripts\sign_windows.ps1"
& $rootScript $Path
exit $LASTEXITCODE
