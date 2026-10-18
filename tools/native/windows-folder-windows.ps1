param([Parameter(Mandatory=$true)][string]$Request)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$requestData = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Request)) | ConvertFrom-Json
$shell = New-Object -ComObject Shell.Application
function FolderWindows {
  foreach ($window in @($shell.Windows())) {
    try {
      if ([IO.Path]::GetFileName($window.FullName) -ine 'explorer.exe') { continue }
      $id = [string]$window.HWND
    } catch { continue }
    # Preserve pre-existing Home/This PC and still-loading windows too.
    $path = ''
    try {
      $folder = $window.Document.Folder.Self
      if ($folder.IsFileSystem -and [IO.Path]::IsPathRooted([string]$folder.Path)) { $path = [IO.Path]::GetFullPath([string]$folder.Path) }
    } catch {}
    [PSCustomObject]@{ id = $id; path = $path; window = $window }
  }
}
if ($requestData.operation -eq 'snapshot') {
  $entries = @(FolderWindows | ForEach-Object { @{ id = $_.id; path = $_.path } })
  ConvertTo-Json -InputObject $entries -Compress
} elseif ($requestData.operation -eq 'close') {
  $closed = @()
  foreach ($group in @(FolderWindows | Group-Object id)) {
    # Recheck identity AND every registered tab path immediately before Quit.
    $expected = @($requestData.windows | Where-Object { $_.id -eq $group.Name })
    if (!$expected.Count) { continue }
    $foreign = @($group.Group | Where-Object { $actual = $_.path; !@($expected | Where-Object { $_.path -ieq $actual }).Count })
    if ($foreign.Count) { continue }
    $group.Group[0].window.Quit()
    $closed += $group.Name
  }
  ConvertTo-Json -InputObject @{ closed = @($closed) } -Compress
} else { throw 'Unsupported folder-window operation' }
