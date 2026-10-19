$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This dependency setup is restricted to disposable GitHub runners.' }

# Microsoft documents these Runtime keys separately from the Edge browser.
# https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution
function Get-RuntimeVersion {
  foreach ($key in @(
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
  )) {
    $value = (Get-ItemProperty -LiteralPath $key -Name pv -ErrorAction SilentlyContinue).pv
    if ($value -and [version]$value -gt [version]'0.0.0.0') { return $value }
  }
  return $null
}

$before = Get-RuntimeVersion
$installed = $false
if (!$before) {
  New-Item -ItemType Directory -Force test-results | Out-Null
  $setup = Join-Path (Resolve-Path test-results) 'MicrosoftEdgeWebview2Setup.exe'
  Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $setup
  $signature = Get-AuthenticodeSignature -LiteralPath $setup
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
    throw 'WebView2 bootstrapper is not validly signed by Microsoft.'
  }
  $process = Start-Process -FilePath $setup -ArgumentList '/silent','/install' -PassThru
  if (!$process.WaitForExit(180000)) { throw 'WebView2 dependency installation timed out.' }
  for ($attempt = 0; $attempt -lt 30 -and !(Get-RuntimeVersion); $attempt++) { Start-Sleep -Seconds 2 }
  $installed = $true
}
$after = Get-RuntimeVersion
if (!$after) { throw 'WebView2 Runtime remains unavailable; native acceptance cannot proceed.' }
New-Item -ItemType Directory -Force test-results | Out-Null
@{ before=$before; version=$after; installedForRunner=$installed; sessionId=(Get-Process -Id $PID).SessionId } |
  ConvertTo-Json | Set-Content test-results/windows-webview2-runtime.json -Encoding utf8
Write-Output "WebView2 Runtime ready: $after; installed for runner: $installed"
