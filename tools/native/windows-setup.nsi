Unicode true
RequestExecutionLevel user
ManifestDPIAware true
SetFont "Microsoft YaHei UI" 10
!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "FileFunc.nsh"
!include "WordFunc.nsh"
!include "x64.nsh"
Name "XwX Deck"
Caption "XwX Deck 安装程序"
UninstallCaption "XwX Deck 卸载程序"
BrandingText " "
OutFile "@@OUTPUT@@"
InstallDir "$LOCALAPPDATA\Programs\XwX Deck"
SetCompressor /SOLID lzma
SetOverwrite on
ShowInstDetails nevershow
ShowUninstDetails nevershow
VIProductVersion "@@VERSION@@.0"
VIAddVersionKey /LANG=1033 "ProductName" "XwX Deck Setup"
VIAddVersionKey /LANG=1033 "ProductVersion" "@@VERSION@@"
VIAddVersionKey /LANG=1033 "FileVersion" "@@VERSION@@"
VIAddVersionKey /LANG=1033 "FileDescription" "XwX Deck per-user setup"
VIAddVersionKey /LANG=1033 "OriginalFilename" "XwX-Deck-windows-x64-setup.exe"
VIAddVersionKey /LANG=1033 "InstallScope" "per-user"
VIAddVersionKey /LANG=1033 "LegalCopyright" "XwX Deck"
!define KEY "Software\XwX Deck\Installation"
!define ARP "Software\Microsoft\Windows\CurrentVersion\Uninstall\XwX Deck"
!define MUI_ICON "@@ICON@@"
!define MUI_UNICON "@@ICON@@"
!define MUI_BGCOLOR FFFFFF
!define MUI_TEXTCOLOR 191A18
!define MUI_INSTFILESPAGE_PROGRESSBAR smooth
!define MUI_INSTFILESPAGE_HEADER_TEXT "正在$OperationName XwX Deck"
!define MUI_CUSTOMFUNCTION_ABORT Rollback
Page custom InstallPage InstallLeave
!define MUI_PAGE_CUSTOMFUNCTION_SHOW InstallProgress
!insertmacro MUI_PAGE_INSTFILES
Page custom FinishPage FinishLeave
UninstPage custom un.ConfirmPage un.ConfirmLeave
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.Progress
!insertmacro MUI_UNPAGE_INSTFILES
UninstPage custom un.FinishPage
!insertmacro MUI_LANGUAGE "SimpChinese"

Var Dialog
Var LocationField
Var BrowseButton
Var ErrorLabel
Var ErrorMessage
Var InitError
Var PreviousPath
Var PreviousVersion
Var PreviousHash
Var PreviousSize
Var Stage
Var HadApp
Var HadUninstaller
Var HadShortcut
Var WriteShortcut
Var LogPath
Var LogHandle
Var Mutex
Var LaunchBox
Var OperationName
Var PilotRoot
Var OwnStaging
Var OwnNewApp
Var OwnNewUninstaller
Var RollbackFailed
Var UninstallMetadataTouched
Var PreviousStartup

!macro Log Message
  DetailPrint "${Message}"
  FileWrite $LogHandle "${Message}$\r$\n"
!macroend

Function .onInit
  SetShellVarContext current
  SetRegView 64
  InitPluginsDir
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Local\app.xwxdeck.desktop.setup") p .r0 ?e'
  Pop $1
  StrCpy $Mutex $0
  ${If} $0 == 0
  ${OrIf} $1 == 183
    SetErrorLevel 2
    Quit
  ${EndIf}
  System::Call 'kernel32::GetCurrentProcessId() i .r0'
  StrCpy $LogPath "$TEMP\XwXDeck-setup-$0.log"
  ${GetParameters} $0
  ${GetOptions} $0 "/PILOTROOT=" $PilotRoot
  ${GetOptions} $0 "/LOG=" $1
  ${If} $1 != ""
    StrCpy $LogPath $1
  ${EndIf}
  FileOpen $LogHandle $LogPath w
  StrCpy $Stage 0
  StrCpy $OperationName "安装"
  ReadRegStr $PreviousPath HKCU "${KEY}" "Path"
  ReadRegStr $PreviousVersion HKCU "${KEY}" "Version"
  ReadRegStr $PreviousHash HKCU "${KEY}" "BinarySha256"
  ReadRegDWORD $PreviousSize HKCU "${ARP}" "EstimatedSize"
  ${If} $PreviousPath != ""
    ReadRegStr $0 HKCU "${KEY}" "InstallerType"
    ReadRegStr $1 HKCU "${KEY}" "AppId"
    ${If} $0 != "nsis-v1"
    ${OrIf} $1 != "app.xwxdeck.desktop"
      StrCpy $ErrorMessage "请先卸载已有的其他安装形式，再运行本安装包。配置和数据保留。"
    ${Else}
      StrCpy $INSTDIR $PreviousPath
      ${VersionCompare} "@@VERSION@@" $PreviousVersion $0
      StrCpy $OperationName "更新"
      ${If} $0 == 0
        StrCpy $OperationName "修复"
      ${EndIf}
      ${If} $0 == 2
        StrCpy $ErrorMessage "已安装更新版本，请使用已安装的 XwX Deck。"
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ${IfNot} ${RunningX64}
    StrCpy $ErrorMessage "本安装包需要 64 位 Windows。"
  ${EndIf}
  StrCpy $InitError $ErrorMessage
  SetOutPath "$PLUGINSDIR"
  File /oname=guard.exe "@@BINARY@@"
  File /oname=XwXSetupSkin.dll "@@SKIN@@"
  ${If} ${Silent}
    Call ValidateTarget
    ${If} $ErrorMessage != ""
      !insertmacro Log "$ErrorMessage"
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}
FunctionEnd

Function ValidateTarget
  ${If} $ErrorMessage != ""
    Return
  ${EndIf}
  ${GetRoot} "$INSTDIR" $0
  ${If} $INSTDIR == ""
  ${OrIf} $INSTDIR == $0
  ${OrIf} $INSTDIR == "$0\"
    StrCpy $ErrorMessage "请选择应用的安装文件夹，不能安装在磁盘根目录。"
    Return
  ${EndIf}
  ClearErrors
  ExecWait '"$PLUGINSDIR\guard.exe" --check-setup-target "$INSTDIR\XwX Deck.exe"' $0
  ${If} ${Errors}
  ${OrIf} $0 != 0
    StrCpy $ErrorMessage "无法安全安装。请从托盘退出已安装的 XwX Deck，或选择没有同名程序的文件夹。"
  ${EndIf}
FunctionEnd

Function InstallPage
  nsDialogs::Create 1018
  Pop $Dialog
  ${NSD_CreateLabel} 225 78 363 18 "安装位置"
  Pop $0
  System::Call /NOUNLOAD '$PLUGINSDIR\XwXSetupSkin.dll::Skin(p $HWNDPARENT, p $Dialog, w "@@VERSION@@", i 0)'
  System::Call /NOUNLOAD '$PLUGINSDIR\XwXSetupSkin.dll::Field(p $0, i 2)'
  ${NSD_CreateText} 247 108 303 22 "$INSTDIR"
  Pop $LocationField
  System::Call /NOUNLOAD '$PLUGINSDIR\XwXSetupSkin.dll::Field(p $LocationField, i 0)'
  ${NSD_CreateButton} 558 104 36 28 "更改"
  Pop $BrowseButton
  System::Call /NOUNLOAD '$PLUGINSDIR\XwXSetupSkin.dll::Field(p $BrowseButton, i 1)'
  ${NSD_OnClick} $BrowseButton Browse
  ${If} $PreviousPath != ""
    SendMessage $LocationField ${EM_SETREADONLY} 1 0
    EnableWindow $BrowseButton 0
  ${EndIf}
  ${NSD_CreateLabel} 225 140 363 34 "$ErrorMessage"
  Pop $ErrorLabel
  System::Call /NOUNLOAD '$PLUGINSDIR\XwXSetupSkin.dll::Field(p $ErrorLabel, i 3)'
  SetCtlColors $ErrorLabel A63429 FFFFFF
  ${If} $ErrorMessage == ""
    ShowWindow $ErrorLabel ${SW_HIDE}
  ${EndIf}
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:$OperationName"
  nsDialogs::Show
FunctionEnd

Function Browse
  nsDialogs::SelectFolderDialog "选择安装位置" "$INSTDIR"
  Pop $0
  ${If} $0 != "error"
    StrCpy $INSTDIR $0
    ${NSD_SetText} $LocationField $INSTDIR
  ${EndIf}
FunctionEnd

Function InstallLeave
  ${NSD_GetText} $LocationField $INSTDIR
  StrCpy $ErrorMessage $InitError
  Call ValidateTarget
  ${If} $ErrorMessage != ""
    ${NSD_SetText} $ErrorLabel $ErrorMessage
    ShowWindow $ErrorLabel ${SW_SHOW}
    Abort
  ${EndIf}
FunctionEnd

Function FinishPage
  nsDialogs::Create 1018
  Pop $Dialog
  System::Call /NOUNLOAD '$PLUGINSDIR\XwXSetupSkin.dll::Skin(p $HWNDPARENT, p $Dialog, w "@@VERSION@@", i 1)'
  ${NSD_CreateLabel} 225 78 363 22 "$OperationName完成"
  Pop $0
  System::Call /NOUNLOAD '$PLUGINSDIR\XwXSetupSkin.dll::Field(p $0, i 4)'
  ${NSD_CreateCheckbox} 225 111 363 24 "启动 XwX Deck"
  Pop $LaunchBox
  System::Call /NOUNLOAD '$PLUGINSDIR\XwXSetupSkin.dll::Field(p $LaunchBox, i 5)'
  ${NSD_Check} $LaunchBox
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:完成"
  GetDlgItem $0 $HWNDPARENT 3
  EnableWindow $0 0
  GetDlgItem $0 $HWNDPARENT 2
  EnableWindow $0 0
  nsDialogs::Show
FunctionEnd

Function InstallProgress
  StrCpy $Dialog $mui.InstFilesPage
  System::Call /NOUNLOAD '$PLUGINSDIR\XwXSetupSkin.dll::Skin(p $HWNDPARENT, p $Dialog, w "@@VERSION@@", i 2)'
FunctionEnd

Function FinishLeave
  ${NSD_GetState} $LaunchBox $0
  ${If} $0 == ${BST_CHECKED}
    ${If} $PilotRoot == ""
      ExecShell "open" "$INSTDIR\XwX Deck.exe"
    ${Else}
      ExecShell "open" "$INSTDIR\XwX Deck.exe" '--pilot-root "$PilotRoot"'
    ${EndIf}
  ${EndIf}
FunctionEnd

Function Rollback
  ${If} $Stage == 0
  ${OrIf} $Stage == 9
    Return
  ${EndIf}
  StrCpy $RollbackFailed 0
  ClearErrors
  ${If} $OwnStaging == 1
    Delete "$INSTDIR\.xwx-deck-new.exe"
  ${EndIf}
  IfErrors 0 +2
    StrCpy $RollbackFailed 1
  ${If} $Stage >= 2
    ClearErrors
    ${If} $OwnNewApp == 1
      Delete "$INSTDIR\XwX Deck.exe"
    ${EndIf}
    ${If} $HadApp == 1
      Rename "$INSTDIR\.xwx-deck-old.exe" "$INSTDIR\XwX Deck.exe"
    ${EndIf}
    IfErrors 0 +2
      StrCpy $RollbackFailed 1
    ClearErrors
    ${If} $OwnNewUninstaller == 1
      Delete "$INSTDIR\uninstall.exe"
    ${EndIf}
    ${If} $HadUninstaller == 1
      Rename "$INSTDIR\.xwx-deck-old-uninstall.exe" "$INSTDIR\uninstall.exe"
    ${EndIf}
    IfErrors 0 +2
      StrCpy $RollbackFailed 1
    ClearErrors
    ${If} $Stage >= 3
    ${AndIf} $WriteShortcut == 1
      ${If} $HadShortcut == 1
        CopyFiles /SILENT "$PLUGINSDIR\previous-shortcut.lnk" "$SMPROGRAMS\XwX Deck.lnk"
      ${Else}
        Delete "$SMPROGRAMS\XwX Deck.lnk"
      ${EndIf}
    ${EndIf}
    IfErrors 0 +2
      StrCpy $RollbackFailed 1
  ${EndIf}
  ${If} $Stage >= 4
    ClearErrors
    ${If} $PreviousPath == ""
      DeleteRegKey HKCU "${KEY}"
      DeleteRegKey HKCU "${ARP}"
    ${Else}
      WriteRegStr HKCU "${KEY}" "Version" $PreviousVersion
      WriteRegStr HKCU "${KEY}" "BinarySha256" $PreviousHash
      WriteRegStr HKCU "${ARP}" "DisplayVersion" $PreviousVersion
      WriteRegDWORD HKCU "${ARP}" "EstimatedSize" $PreviousSize
    ${EndIf}
    IfErrors 0 +2
      StrCpy $RollbackFailed 1
  ${EndIf}
  StrCpy $Stage 0
  ${If} $RollbackFailed == 1
    !insertmacro Log "恢复未完成；请保留安装目录中的 .xwx-deck-old 文件，并使用本安装包重试。日志：$LogPath"
  ${Else}
    !insertmacro Log "原程序文件已恢复；配置和数据保留。"
  ${EndIf}
FunctionEnd

Section "XwX Deck"
  Call ValidateTarget
  ${If} $ErrorMessage != ""
    !insertmacro Log "$ErrorMessage"
    SetErrorLevel 2
    Abort
  ${EndIf}
  StrCpy $OwnStaging 0
  StrCpy $OwnNewApp 0
  StrCpy $OwnNewUninstaller 0
  StrCpy $Stage 1
  ClearErrors
  CreateDirectory "$INSTDIR"
  SetOutPath "$INSTDIR"
  !insertmacro Log "准备程序文件"
  IfFileExists "$INSTDIR\.xwx-deck-new.exe" install_failed
  IfFileExists "$INSTDIR\.xwx-deck-old.exe" install_failed
  IfFileExists "$INSTDIR\.xwx-deck-old-uninstall.exe" install_failed
  ; Reserve the name atomically. Never claim/delete a file created by someone else.
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\.xwx-deck-new.exe", i 0x40000000, i 0, p 0, i 1, i 128, p 0) p .r0'
  ${If} $0 == -1
    Goto install_failed
  ${EndIf}
  System::Call 'kernel32::CloseHandle(p r0)'
  StrCpy $OwnStaging 1
  ; A Win32 copy returns an error without a system Retry/Ignore dialog.
  System::Call 'kernel32::CopyFileW(w "$PLUGINSDIR\guard.exe", w "$INSTDIR\.xwx-deck-new.exe", i 0) i .r0'
  ${If} $0 == 0
    Goto install_failed
  ${EndIf}
  StrCpy $HadShortcut 0
  StrCpy $WriteShortcut 0
  ExecWait '"$PLUGINSDIR\guard.exe" --check-setup-shortcut "$INSTDIR\XwX Deck.exe"' $0
  ${If} $0 == 0
    StrCpy $WriteShortcut 1
    IfFileExists "$SMPROGRAMS\XwX Deck.lnk" 0 +4
      CopyFiles /SILENT "$SMPROGRAMS\XwX Deck.lnk" "$PLUGINSDIR\previous-shortcut.lnk"
      IfErrors install_failed
      StrCpy $HadShortcut 1
  ${EndIf}
  StrCpy $HadApp 0
  StrCpy $HadUninstaller 0
  IfFileExists "$INSTDIR\XwX Deck.exe" 0 +5
    Rename "$INSTDIR\XwX Deck.exe" "$INSTDIR\.xwx-deck-old.exe"
    IfErrors install_failed
    StrCpy $HadApp 1
    StrCpy $Stage 2
  IfFileExists "$INSTDIR\uninstall.exe" 0 +4
    Rename "$INSTDIR\uninstall.exe" "$INSTDIR\.xwx-deck-old-uninstall.exe"
    IfErrors install_failed
    StrCpy $HadUninstaller 1
  StrCpy $Stage 2
  !insertmacro Log "安装 XwX Deck"
  Rename "$INSTDIR\.xwx-deck-new.exe" "$INSTDIR\XwX Deck.exe"
  IfErrors install_failed
  StrCpy $OwnStaging 0
  StrCpy $OwnNewApp 1
  !if @@FAILURE_FIXTURE@@ == 1
    Goto install_failed
  !endif
  StrCpy $Stage 3
  StrCpy $OwnNewUninstaller 1
  WriteUninstaller "$INSTDIR\uninstall.exe"
  IfErrors install_failed
  ${If} $WriteShortcut == 1
    CreateShortCut "$SMPROGRAMS\XwX Deck.lnk" "$INSTDIR\XwX Deck.exe"
    IfErrors install_failed
  ${EndIf}
  !insertmacro Log "登记当前用户安装"
  StrCpy $Stage 4
  WriteRegStr HKCU "${KEY}" "AppId" "app.xwxdeck.desktop"
  WriteRegStr HKCU "${KEY}" "InstallerType" "nsis-v1"
  WriteRegStr HKCU "${KEY}" "Path" "$INSTDIR"
  WriteRegStr HKCU "${KEY}" "Version" "@@VERSION@@"
  WriteRegStr HKCU "${KEY}" "BinarySha256" "@@BINARY_SHA256@@"
  WriteRegStr HKCU "${ARP}" "DisplayName" "XwX Deck"
  WriteRegStr HKCU "${ARP}" "DisplayVersion" "@@VERSION@@"
  WriteRegStr HKCU "${ARP}" "Publisher" "XwX Deck"
  WriteRegStr HKCU "${ARP}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${ARP}" "DisplayIcon" '$\"$INSTDIR\XwX Deck.exe$\",0'
  WriteRegStr HKCU "${ARP}" "UninstallString" '$\"$INSTDIR\uninstall.exe$\"'
  WriteRegStr HKCU "${ARP}" "QuietUninstallString" '$\"$INSTDIR\uninstall.exe$\" /S'
  WriteRegDWORD HKCU "${ARP}" "NoModify" 1
  WriteRegDWORD HKCU "${ARP}" "NoRepair" 1
  FileOpen $0 "$INSTDIR\XwX Deck.exe" r
  FileSeek $0 0 END $1
  FileClose $0
  FileOpen $0 "$INSTDIR\uninstall.exe" r
  FileSeek $0 0 END $2
  FileClose $0
  IntOp $1 $1 + $2
  IntOp $1 $1 / 1024
  WriteRegDWORD HKCU "${ARP}" "EstimatedSize" $1
  IfErrors install_failed
  !if @@FAILURE_FIXTURE@@ == 2
    Goto install_failed
  !endif
  StrCpy $Stage 9
  Delete "$INSTDIR\.xwx-deck-old.exe"
  Delete "$INSTDIR\.xwx-deck-old-uninstall.exe"
  !insertmacro Log "安装完成；配置和数据保留"
  SetErrorLevel 0
  Goto install_done
install_failed:
  Call Rollback
  SetErrorLevel 3
  ${If} $RollbackFailed == 1
    Abort "安装失败，恢复未完成。请保留安装目录及日志：$LogPath"
  ${Else}
    Abort "安装未完成。配置与数据保留，请查看安装日志：$LogPath"
  ${EndIf}
install_done:
SectionEnd

Function un.onInit
  SetShellVarContext current
  SetRegView 64
  InitPluginsDir
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Local\app.xwxdeck.desktop.setup") p .r0 ?e'
  Pop $1
  StrCpy $Mutex $0
  ${If} $0 == 0
  ${OrIf} $1 == 183
    SetErrorLevel 2
    Quit
  ${EndIf}
  ReadRegStr $PreviousPath HKCU "${KEY}" "Path"
  ReadRegStr $0 HKCU "${KEY}" "InstallerType"
  ${If} $PreviousPath != $INSTDIR
  ${OrIf} $0 != "nsis-v1"
    SetErrorLevel 2
    Quit
  ${EndIf}
  ReadRegStr $PreviousVersion HKCU "${KEY}" "Version"
  ReadRegStr $PreviousHash HKCU "${KEY}" "BinarySha256"
  ReadRegDWORD $PreviousSize HKCU "${ARP}" "EstimatedSize"
  ReadRegStr $PreviousStartup HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "XwX Deck"
  SetOutPath "$PLUGINSDIR"
  File /oname=guard.exe "@@BINARY@@"
  File /oname=XwXSetupSkin.dll "@@SKIN@@"
  ${If} ${Silent}
    Call un.ConfirmLeave
  ${EndIf}
FunctionEnd

Function un.ConfirmPage
  nsDialogs::Create 1018
  Pop $Dialog
  System::Call /NOUNLOAD '$PLUGINSDIR\XwXSetupSkin.dll::Skin(p $HWNDPARENT, p $Dialog, w "@@VERSION@@", i 3)'
  ${NSD_CreateLabel} 225 78 363 22 "卸载 XwX Deck？"
  Pop $0
  System::Call /NOUNLOAD '$PLUGINSDIR\XwXSetupSkin.dll::Field(p $0, i 4)'
  ${NSD_CreateLabel} 225 106 363 44 "配置、账号、日志和 Trace 数据保留。"
  Pop $0
  System::Call /NOUNLOAD '$PLUGINSDIR\XwXSetupSkin.dll::Field(p $0, i 6)'
  ${NSD_CreateLabel} 225 140 363 34 "$ErrorMessage"
  Pop $ErrorLabel
  System::Call /NOUNLOAD '$PLUGINSDIR\XwXSetupSkin.dll::Field(p $ErrorLabel, i 3)'
  SetCtlColors $ErrorLabel A63429 FFFFFF
  ShowWindow $ErrorLabel ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:卸载"
  nsDialogs::Show
FunctionEnd

Function un.ConfirmLeave
  ClearErrors
  ExecWait '"$PLUGINSDIR\guard.exe" --check-setup-uninstall "$INSTDIR\XwX Deck.exe"' $0
  ${If} ${Errors}
  ${OrIf} $0 != 0
    StrCpy $ErrorMessage "请先从托盘退出 XwX Deck，再卸载。当前程序和数据保留。"
    ${IfNot} ${Silent}
      ${NSD_SetText} $ErrorLabel $ErrorMessage
      ShowWindow $ErrorLabel ${SW_SHOW}
      Abort
    ${EndIf}
    SetErrorLevel 2
    Quit
  ${EndIf}
FunctionEnd

Function un.FinishPage
  nsDialogs::Create 1018
  Pop $Dialog
  System::Call /NOUNLOAD '$PLUGINSDIR\XwXSetupSkin.dll::Skin(p $HWNDPARENT, p $Dialog, w "@@VERSION@@", i 4)'
  ${NSD_CreateLabel} 225 78 363 22 "卸载完成"
  Pop $0
  System::Call /NOUNLOAD '$PLUGINSDIR\XwXSetupSkin.dll::Field(p $0, i 4)'
  ${NSD_CreateLabel} 225 106 363 44 "配置、账号、日志和 Trace 数据保留。"
  Pop $0
  System::Call /NOUNLOAD '$PLUGINSDIR\XwXSetupSkin.dll::Field(p $0, i 6)'
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:完成"
  GetDlgItem $0 $HWNDPARENT 3
  EnableWindow $0 0
  GetDlgItem $0 $HWNDPARENT 2
  EnableWindow $0 0
  nsDialogs::Show
FunctionEnd

Function un.Progress
  StrCpy $Dialog $mui.InstFilesPage
  System::Call /NOUNLOAD '$PLUGINSDIR\XwXSetupSkin.dll::Skin(p $HWNDPARENT, p $Dialog, w "@@VERSION@@", i 2)'
FunctionEnd

Function un.RestoreRegistration
  ClearErrors
  WriteRegStr HKCU "${KEY}" "AppId" "app.xwxdeck.desktop"
  WriteRegStr HKCU "${KEY}" "InstallerType" "nsis-v1"
  WriteRegStr HKCU "${KEY}" "Path" "$PreviousPath"
  WriteRegStr HKCU "${KEY}" "Version" "$PreviousVersion"
  WriteRegStr HKCU "${KEY}" "BinarySha256" "$PreviousHash"
  WriteRegStr HKCU "${ARP}" "DisplayName" "XwX Deck"
  WriteRegStr HKCU "${ARP}" "DisplayVersion" "$PreviousVersion"
  WriteRegStr HKCU "${ARP}" "Publisher" "XwX Deck"
  WriteRegStr HKCU "${ARP}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${ARP}" "DisplayIcon" '$\"$INSTDIR\XwX Deck.exe$\",0'
  WriteRegStr HKCU "${ARP}" "UninstallString" '$\"$INSTDIR\uninstall.exe$\"'
  WriteRegStr HKCU "${ARP}" "QuietUninstallString" '$\"$INSTDIR\uninstall.exe$\" /S'
  WriteRegDWORD HKCU "${ARP}" "NoModify" 1
  WriteRegDWORD HKCU "${ARP}" "NoRepair" 1
  WriteRegDWORD HKCU "${ARP}" "EstimatedSize" $PreviousSize
  IfErrors 0 +2
    StrCpy $RollbackFailed 1
FunctionEnd

Section "Uninstall"
  StrCpy $Stage 0
  StrCpy $RollbackFailed 0
  StrCpy $UninstallMetadataTouched 0
  Call un.ConfirmLeave
  ClearErrors
  CopyFiles /SILENT "$INSTDIR\uninstall.exe" "$PLUGINSDIR\recovery-uninstall.exe"
  IfErrors uninstall_failed
  StrCpy $HadShortcut 0
  ExecWait '"$PLUGINSDIR\guard.exe" --check-setup-shortcut "$INSTDIR\XwX Deck.exe"' $0
  ${If} $0 == 0
    IfFileExists "$SMPROGRAMS\XwX Deck.lnk" 0 +4
      CopyFiles /SILENT "$SMPROGRAMS\XwX Deck.lnk" "$PLUGINSDIR\recovery-shortcut.lnk"
      IfErrors uninstall_failed
      StrCpy $HadShortcut 1
  ${EndIf}
  IfFileExists "$INSTDIR\.xwx-deck-remove.exe" uninstall_failed
  Rename "$INSTDIR\XwX Deck.exe" "$INSTDIR\.xwx-deck-remove.exe"
  IfErrors uninstall_failed
  StrCpy $Stage 1
  ExecWait '"$PLUGINSDIR\guard.exe" --finish-setup-uninstall "$INSTDIR\XwX Deck.exe"' $0
  ${If} ${Errors}
  ${OrIf} $0 != 0
    Goto uninstall_failed
  ${EndIf}
  ; Keep the application backup and uninstall entry until metadata deletion succeeds.
  StrCpy $UninstallMetadataTouched 1
  ClearErrors
  DeleteRegKey HKCU "${ARP}"
  IfErrors uninstall_failed
  DeleteRegKey HKCU "${KEY}"
  IfErrors uninstall_failed
  !if @@FAILURE_FIXTURE@@ == 3
    Goto uninstall_failed
  !endif
  Delete "$INSTDIR\uninstall.exe"
  IfErrors uninstall_failed
  Delete "$INSTDIR\.xwx-deck-remove.exe"
  IfErrors uninstall_failed
  StrCpy $Stage 9
  RMDir "$INSTDIR"
  SetErrorLevel 0
  Goto uninstall_done
uninstall_failed:
  ${If} $Stage == 1
    ClearErrors
    ${If} ${FileExists} "$INSTDIR\.xwx-deck-remove.exe"
      Rename "$INSTDIR\.xwx-deck-remove.exe" "$INSTDIR\XwX Deck.exe"
    ${Else}
      CopyFiles /SILENT "$PLUGINSDIR\guard.exe" "$INSTDIR\XwX Deck.exe"
    ${EndIf}
    IfErrors 0 +2
      StrCpy $RollbackFailed 1
    ClearErrors
    CopyFiles /SILENT "$PLUGINSDIR\recovery-uninstall.exe" "$INSTDIR\uninstall.exe"
    IfErrors 0 +2
      StrCpy $RollbackFailed 1
    ${If} $UninstallMetadataTouched == 1
      Call un.RestoreRegistration
    ${EndIf}
    ; Do not overwrite a shortcut or startup choice changed externally during uninstall.
    ${If} $HadShortcut == 1
      ExecWait '"$PLUGINSDIR\guard.exe" --check-setup-shortcut "$INSTDIR\XwX Deck.exe"' $0
      ${If} $0 == 0
        ClearErrors
        CopyFiles /SILENT "$PLUGINSDIR\recovery-shortcut.lnk" "$SMPROGRAMS\XwX Deck.lnk"
        IfErrors 0 +2
          StrCpy $RollbackFailed 1
      ${EndIf}
    ${EndIf}
    StrCpy $0 '$\"$INSTDIR\XwX Deck.exe$\"'
    StrLen $1 $0
    StrCpy $2 $PreviousStartup $1
    ${If} $2 == $0
      ReadRegStr $3 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "XwX Deck"
      ${If} $3 == ""
        ClearErrors
        WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "XwX Deck" "$PreviousStartup"
        IfErrors 0 +2
          StrCpy $RollbackFailed 1
      ${EndIf}
    ${EndIf}
  ${EndIf}
  SetErrorLevel 3
  ${If} $RollbackFailed == 1
    Abort "卸载失败，恢复未完成。请保留安装目录和恢复文件，使用安装包修复。配置和数据保留。"
  ${Else}
    Abort "卸载未完成。配置和数据保留，可使用原卸载入口重试。"
  ${EndIf}
uninstall_done:
SectionEnd
