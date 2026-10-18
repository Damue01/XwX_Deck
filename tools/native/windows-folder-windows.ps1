param([Parameter(Mandatory=$true)][string]$Request)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$requestData = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Request)) | ConvertFrom-Json
$shell = New-Object -ComObject Shell.Application
function FolderWindows {
  foreach ($window in @($shell.Windows())) {
    try {
      if ([IO.Path]::GetFileName($window.FullName) -ine 'explorer.exe') { continue }
      $path = [string]$window.Document.Folder.Self.Path
      if (![IO.Path]::IsPathRooted($path) -or !$window.Document.Folder.Self.IsFileSystem) { continue }
      [PSCustomObject]@{ id = [string]$window.HWND; path = [IO.Path]::GetFullPath($path); window = $window }
    } catch { continue }
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
