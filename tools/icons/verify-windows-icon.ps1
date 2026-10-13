param(
  [Parameter(Mandatory = $true)]
  [string]$ArtifactPath,
  [string]$ExpectedVersion = '',
  [string]$ExpectedProductName = 'XwX Deck'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$resolvedArtifact = (Resolve-Path -LiteralPath $ArtifactPath).Path
$versionInfo = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($resolvedArtifact)
if ($ExpectedVersion) {
  $actualVersion = [string]$versionInfo.ProductVersion
  $versionMatch = [regex]::Match($actualVersion, '^\d+\.\d+\.\d+')
  if (-not $versionMatch.Success -or $versionMatch.Value -ne $ExpectedVersion) {
    throw "Packaged executable product version '$actualVersion' does not match '$ExpectedVersion': $resolvedArtifact"
  }
}
if ($ExpectedProductName) {
  if ([string]$versionInfo.ProductName -ne $ExpectedProductName) {
    throw "Packaged executable product name '$($versionInfo.ProductName)' does not match '$ExpectedProductName': $resolvedArtifact"
  }
  if (-not ([string]$versionInfo.FileDescription).StartsWith($ExpectedProductName, [System.StringComparison]::Ordinal)) {
    throw "Packaged executable file description '$($versionInfo.FileDescription)' does not start with '$ExpectedProductName': $resolvedArtifact"
  }
}
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($resolvedArtifact)
if ($null -eq $icon) {
  throw "Packaged executable has no extractable Windows icon: $resolvedArtifact"
}

try {
  $bitmap = $icon.ToBitmap()
  try {
    $opaquePixels = 0
    $darkPixels = 0
    $lightPixels = 0
    $totalPixels = $bitmap.Width * $bitmap.Height

    for ($y = 0; $y -lt $bitmap.Height; $y++) {
      for ($x = 0; $x -lt $bitmap.Width; $x++) {
        $pixel = $bitmap.GetPixel($x, $y)
        if ($pixel.A -lt 224) {
          continue
        }

        $opaquePixels++
        $brightness = ($pixel.R + $pixel.G + $pixel.B) / 3
        if ($brightness -le 48) {
          $darkPixels++
        }
        if ($brightness -ge 192) {
          $lightPixels++
        }
      }
    }

    # The XwX icon is a predominantly black tile with a visible white mark.
    # These bounds reject a missing/transparent icon and Windows' white generic
    # document fallback without tying the gate to exact antialiasing bytes.
    if ($opaquePixels -lt [Math]::Floor($totalPixels * 0.75) `
        -or $darkPixels -lt [Math]::Floor($totalPixels * 0.50) `
        -or $lightPixels -lt [Math]::Floor($totalPixels * 0.01)) {
      throw "Packaged executable icon is blank or does not match the XwX icon profile: $resolvedArtifact"
    }

    Write-Output "[icon-check] PASS $ExpectedProductName $($bitmap.Width)x$($bitmap.Height) icon and version $($versionInfo.ProductVersion) from $resolvedArtifact"
  } finally {
    $bitmap.Dispose()
  }
} finally {
  $icon.Dispose()
}
