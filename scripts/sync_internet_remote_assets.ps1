param(
    [Parameter(Mandatory = $true)]
    [string]$Destination
)

$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$staticRoot = Join-Path $repositoryRoot "static"
$destinationRoot = if ([System.IO.Path]::IsPathRooted($Destination)) {
    [System.IO.Path]::GetFullPath($Destination)
} else {
    [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $Destination))
}
$files = @(
    "export-download.js",
    "export-guard.js",
    "i18n.json",
    "internet-remote-transport.js",
    "remote-queue.css",
    "remote-queue.js",
    "remote-transport-client.js",
    "remote.css",
    "remote.html",
    "remote.js",
    "song-detail.css",
    "song-detail.js"
)

New-Item -ItemType Directory -Path $destinationRoot -Force | Out-Null
foreach ($file in $files) {
    Copy-Item -LiteralPath (Join-Path $staticRoot $file) -Destination (Join-Path $destinationRoot $file) -Force
}

$sourcePictures = Join-Path $staticRoot "pic"
$destinationPictures = Join-Path $destinationRoot "pic"
New-Item -ItemType Directory -Path $destinationPictures -Force | Out-Null
Get-ChildItem -LiteralPath $sourcePictures -File | Copy-Item -Destination $destinationPictures -Force

Write-Host "Synced the shared bilikara Remote assets to $destinationRoot"
