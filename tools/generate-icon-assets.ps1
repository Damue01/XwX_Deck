param(
  [string]$WorkspaceRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$assetDirectory = Join-Path $WorkspaceRoot 'assets'
$vectorSourcePath = Join-Path $WorkspaceRoot 'assets\icon.svg'
$fileMasterPath = Join-Path $WorkspaceRoot 'design\icon-master-black.png'
$fileMasterSourceHashPath = Join-Path $WorkspaceRoot 'design\icon-master-black.source.sha256'
$iconSizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)

if (-not (Test-Path -LiteralPath $fileMasterPath)) {
  throw "Missing file icon master: $fileMasterPath"
}
if (-not (Test-Path -LiteralPath $vectorSourcePath)) {
  throw "Missing geometric icon source: $vectorSourcePath"
}
if (-not (Test-Path -LiteralPath $fileMasterSourceHashPath)) {
  throw "Missing icon master provenance: $fileMasterSourceHashPath. Run npm run generate:icons:mac after changing assets\icon.svg."
}
$vectorSource = Get-Content -LiteralPath $vectorSourcePath -Raw
if ($vectorSource -match '<text\b' -or $vectorSource -match 'font-family' -or $vectorSource -match '<image\b') {
  throw 'assets\icon.svg must remain a font-free geometric vector source.'
}
$expectedSourceHash = ((Get-Content -LiteralPath $fileMasterSourceHashPath -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
$normalizedVectorSource = $vectorSource.Replace("`r`n", "`n").Replace("`r", "`n")
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
  $sourceBytes = [System.Text.Encoding]::UTF8.GetBytes($normalizedVectorSource)
  $actualSourceHash = [System.BitConverter]::ToString($sha256.ComputeHash($sourceBytes)).Replace('-', '').ToLowerInvariant()
} finally {
  $sha256.Dispose()
}
if ($expectedSourceHash -notmatch '^[a-f0-9]{64}$' -or $expectedSourceHash -ne $actualSourceHash) {
  throw 'design\icon-master-black.png is not proven to match assets\icon.svg. Run npm run generate:icons:mac on macOS and commit the regenerated icon assets before building Windows.'
}

function New-FileIconBitmap {
  param(
    [int]$Size,
    [System.Drawing.Bitmap]$Master
  )

  $renderSize = $Size * 4
  $rendered = [System.Drawing.Bitmap]::new($renderSize, $renderSize, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($rendered)
  $clipPath = [System.Drawing.Drawing2D.GraphicsPath]::new()
  try {
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    # iOS app icons use a continuous corner rather than four circular arcs.
    # A fifth-order superellipse closely matches that smooth, gradually
    # tightening silhouette while remaining deterministic at every icon size.
    $pointCount = 512
    $exponent = 5.0
    $center = $renderSize / 2.0
    $radius = $renderSize / 2.0
    $points = [System.Drawing.PointF[]]::new($pointCount)
    for ($index = 0; $index -lt $pointCount; $index++) {
      $angle = 2.0 * [Math]::PI * $index / $pointCount
      $cosine = [Math]::Cos($angle)
      $sine = [Math]::Sin($angle)
      $x = $center + $radius * [Math]::Sign($cosine) * [Math]::Pow([Math]::Abs($cosine), 2.0 / $exponent)
      $y = $center + $radius * [Math]::Sign($sine) * [Math]::Pow([Math]::Abs($sine), 2.0 / $exponent)
      $points[$index] = [System.Drawing.PointF]::new([single]$x, [single]$y)
    }
    $clipPath.AddLines($points)
    $clipPath.CloseFigure()
    $graphics.SetClip($clipPath)

    $target = [System.Drawing.RectangleF]::new(0, 0, $renderSize, $renderSize)
    $source = [System.Drawing.RectangleF]::new(0, 0, $Master.Width, $Master.Height)
    $graphics.DrawImage($Master, $target, $source, [System.Drawing.GraphicsUnit]::Pixel)
  } finally {
    $clipPath.Dispose()
    $graphics.Dispose()
  }

  $result = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $resizeGraphics = [System.Drawing.Graphics]::FromImage($result)
  try {
    $resizeGraphics.Clear([System.Drawing.Color]::Transparent)
    $resizeGraphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $resizeGraphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $resizeGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $resizeGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $resizeGraphics.DrawImage($rendered, 0, 0, $Size, $Size)
  } finally {
    $resizeGraphics.Dispose()
    $rendered.Dispose()
  }
  return $result
}

function ConvertTo-PngBytes {
  param([System.Drawing.Bitmap]$Bitmap)
  $stream = [System.IO.MemoryStream]::new()
  try {
    $Bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    return ,$stream.ToArray()
  } finally {
    $stream.Dispose()
  }
}

function Write-MultiSizeIcon {
  param(
    [string]$Path,
    [object[]]$Frames
  )

  $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Create)
  $writer = [System.IO.BinaryWriter]::new($stream)
  try {
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]$Frames.Count)

    $offset = 6 + (16 * $Frames.Count)
    foreach ($frame in $Frames) {
      $dimension = if ($frame.Size -ge 256) { 0 } else { $frame.Size }
      $writer.Write([byte]$dimension)
      $writer.Write([byte]$dimension)
      $writer.Write([byte]0)
      $writer.Write([byte]0)
      $writer.Write([uint16]1)
      $writer.Write([uint16]32)
      $writer.Write([uint32]$frame.Bytes.Length)
      $writer.Write([uint32]$offset)
      $offset += $frame.Bytes.Length
    }

    foreach ($frame in $Frames) {
      $writer.Write($frame.Bytes)
    }
  } finally {
    $writer.Dispose()
    $stream.Dispose()
  }
}

$fileMaster = [System.Drawing.Bitmap]::FromFile($fileMasterPath)
try {
  # Window icon (taskbar button + thumbnail) uses the same black continuous-
  # corner tile as the EXE, pinned shortcut, Start menu, and tray.
  $appBitmap = New-FileIconBitmap -Size 256 -Master $fileMaster
  try {
    $appBitmap.Save((Join-Path $assetDirectory 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $appBitmap.Dispose()
  }

  # EXE / pinned / Start-menu icon uses the same black continuous-corner tile.
  $frames = foreach ($size in $iconSizes) {
    $bitmap = New-FileIconBitmap -Size $size -Master $fileMaster
    try {
      [PSCustomObject]@{ Size = $size; Bytes = ConvertTo-PngBytes -Bitmap $bitmap }
    } finally {
      $bitmap.Dispose()
    }
  }
  Write-MultiSizeIcon -Path (Join-Path $assetDirectory 'icon.ico') -Frames $frames

  # Tracing state is communicated by text and menus, so one tray bitmap serves
  # both idle and active states without packaging duplicate bytes.
  $trayBitmap = New-FileIconBitmap -Size 32 -Master $fileMaster
  try {
    $trayBitmap.Save((Join-Path $assetDirectory 'tray.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $trayBitmap.Dispose()
  }
} finally {
  $fileMaster.Dispose()
}

Write-Output "Generated Windows icons from the raster master derived from $vectorSourcePath"
