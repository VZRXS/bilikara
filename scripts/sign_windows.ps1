param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Path
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Path)) {
  throw "File to sign was not found: $Path"
}

if ($env:OS -ne "Windows_NT") {
  Write-Host "Skipping Windows code signing on non-Windows runner."
  exit 0
}

$resolvedPath = (Resolve-Path -LiteralPath $Path).Path
$existingSignature = Get-AuthenticodeSignature -FilePath $resolvedPath
if ($existingSignature.Status -eq "Valid") {
  Write-Host "Skipping code signing because the file already has a valid signature: $resolvedPath"
  exit 0
}

$timestampUrl = if ($env:WINDOWS_SIGN_TIMESTAMP_URL) {
  $env:WINDOWS_SIGN_TIMESTAMP_URL
} else {
  "http://timestamp.digicert.com"
}

$certificateBase64 = $env:WINDOWS_SIGN_CERTIFICATE_BASE64
$certificatePath = $env:WINDOWS_SIGN_CERTIFICATE_PATH
$certificatePassword = $env:WINDOWS_SIGN_CERTIFICATE_PASSWORD
$certificateThumbprint = $env:WINDOWS_SIGN_CERTIFICATE_THUMBPRINT

if (-not ($certificateBase64 -or $certificatePath -or $certificateThumbprint)) {
  Write-Host "Skipping Windows code signing because no certificate environment variable was provided."
  Write-Host "Set WINDOWS_SIGN_CERTIFICATE_BASE64 plus WINDOWS_SIGN_CERTIFICATE_PASSWORD, or WINDOWS_SIGN_CERTIFICATE_PATH, or WINDOWS_SIGN_CERTIFICATE_THUMBPRINT."
  exit 0
}

function Get-SignToolPath {
  $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $roots = @(
    ${env:ProgramFiles(x86)},
    $env:ProgramFiles
  ) | Where-Object { $_ }

  foreach ($root in $roots) {
    $kitRoot = Join-Path $root "Windows Kits\10\bin"
    if (-not (Test-Path -LiteralPath $kitRoot)) {
      continue
    }

    $candidate = Get-ChildItem -Path $kitRoot -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
      Sort-Object FullName -Descending |
      Select-Object -First 1
    if ($candidate) {
      return $candidate.FullName
    }
  }

  return $null
}

$signtool = Get-SignToolPath
if (-not $signtool) {
  throw "signtool.exe was not found. Install the Windows SDK or add signtool.exe to PATH."
}

$tempCertificatePath = $null

try {
  $signArgs = @("sign", "/fd", "SHA256", "/tr", $timestampUrl, "/td", "SHA256")

  if ($certificateBase64) {
    $tempCertificatePath = Join-Path ([System.IO.Path]::GetTempPath()) ("bilikara-signing-{0}.pfx" -f ([Guid]::NewGuid().ToString("N")))
    [System.IO.File]::WriteAllBytes($tempCertificatePath, [Convert]::FromBase64String($certificateBase64))
    $signArgs += @("/f", $tempCertificatePath)
    if ($certificatePassword) {
      $signArgs += @("/p", $certificatePassword)
    }
  } elseif ($certificatePath) {
    if (-not (Test-Path -LiteralPath $certificatePath)) {
      throw "WINDOWS_SIGN_CERTIFICATE_PATH does not exist: $certificatePath"
    }
    $signArgs += @("/f", $certificatePath)
    if ($certificatePassword) {
      $signArgs += @("/p", $certificatePassword)
    }
  } elseif ($certificateThumbprint) {
    $signArgs += @("/sha1", $certificateThumbprint)
  }

  $signArgs += @("/v", $resolvedPath)
  & $signtool @signArgs
  if ($LASTEXITCODE -ne 0) {
    throw "signtool.exe failed with exit code $LASTEXITCODE"
  }
} finally {
  if ($tempCertificatePath -and (Test-Path -LiteralPath $tempCertificatePath)) {
    Remove-Item -LiteralPath $tempCertificatePath -Force
  }
}
