param([Parameter(Mandatory=$true)][string]$Request)
$ErrorActionPreference = 'Stop'
$data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Request)) | ConvertFrom-Json
if (!(Test-Path -LiteralPath (Join-Path (Split-Path $data.target) '.xwx-msi-test')) -or !$data.target.EndsWith('.ui-test.msi')) { throw 'Expected an owned MSI test directory' }
Copy-Item -LiteralPath $data.source -Destination $data.target
$installer = New-Object -ComObject WindowsInstaller.Installer
$database = $installer.OpenDatabase($data.target,1)
try {
  if ($data.mode -eq 'rollback') {
    # Force failure after both replacement and old-product removal, before commit.
    $view = $database.OpenView('SELECT `Sequence` FROM `InstallExecuteSequence` WHERE `Action`=''InstallExecute'' OR `Action`=''RemoveExistingProducts''')
    try {
      $view.Execute()
      $sequence = 0
      while ($record = $view.Fetch()) {
        $sequence = [Math]::Max($sequence, $record.IntegerData(1) + 1)
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($record)
      }
    } finally { $view.Close(); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view) }
    foreach ($query in @(
      'INSERT INTO `CustomAction` (`Action`,`Type`,`Target`) VALUES (''DeckTestRollback'',19,''Synthetic rollback failure'')',
      "INSERT INTO ``InstallExecuteSequence`` (``Action``,``Sequence``) VALUES ('DeckTestRollback',$sequence)"
    )) {
      $view = $database.OpenView($query)
      try { $view.Execute() } finally { $view.Close(); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view) }
    }
  }
  # Keep full UI and its progress dialog. Only bypass human entry/finish gates.
  foreach ($action in @('DeckWelcome','DeckMaintenance','DeckRemove','DeckRepair','DeckComplete','DeckFailed','DeckCancelled')) {
    $view = $database.OpenView("UPDATE ``InstallUISequence`` SET ``Condition``='0' WHERE ``Action``='$action'")
    try { $view.Execute() } finally { $view.Close(); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view) }
  }
  $database.Commit()
} finally {
  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($database)
  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer)
}
