Unicode true
RequestExecutionLevel user
ManifestDPIAware true
SetFont "Microsoft YaHei UI" 10
!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "FileFunc.nsh"
!include "WordFunc.nsh"
!include "x64.nsh"
!include "StrFunc.nsh"
${Using:StrFunc} StrRep
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
Var LegacyInstall
Var LegacyLink

!macro Log Message
  FileWrite $LogHandle "${Message}$\r$\n"
!macroend

!macro Status Message
  SetDetailsPrint textonly
  DetailPrint "${Message}"
  SetDetailsPrint none
!macroend

Function .onInit
  SetAutoClose true
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
  ; Windows callers quote the whole argument when a path contains spaces.
  ; FileFunc expects quotes around the value instead; preserve the same value.
  ${StrRep} $0 $0 '$\"/PILOTROOT=' '/PILOTROOT=$\"'
  ${StrRep} $0 $0 '$\"/LOG=' '/LOG=$\"'
  ${GetOptions} $0 "/PILOTROOT=" $PilotRoot
  ${GetOptions} $0 "/LOG=" $1
  ${If} $1 != ""
    StrCpy $LogPath $1
  ${EndIf}
  FileOpen $LogHandle $LogPath w
  !insertmacro Log "准备检查已有安装"
  StrCpy $Stage 0
  SetOutPath "$PLUGINSDIR"
  File /oname=guard.exe "@@BINARY@@"
  File /oname=XwXSetupSkin.dll "@@SKIN@@"
  Call ReadInstallation
  !insertmacro Log "安装检查：$OperationName；$INSTDIR；旧版=$LegacyInstall；$ErrorMessage"
  ${IfNot} ${RunningX64}
    StrCpy $ErrorMessage "本安装包需要 64 位 Windows。"
  ${EndIf}
  StrCpy $InitError $ErrorMessage
  ${If} ${Silent}
    Call ValidateTarget
    ${If} $ErrorMessage != ""
      !insertmacro Log "$ErrorMessage"
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}
FunctionEnd

Function ReadInstallation
  StrCpy $ErrorMessage ""
  StrCpy $LegacyInstall 0
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
      ExecWait '"$PLUGINSDIR\guard.exe" --check-legacy-setup "$PreviousPath\XwX Deck.exe"' $2
      !insertmacro Log "旧版产品核对结果：$2"
      StrCpy $INSTDIR $PreviousPath
      ${If} $2 == 0
        StrCpy $LegacyInstall 1
        StrCpy $OperationName "升级安装"
        ${VersionCompare} "@@VERSION@@" $PreviousVersion $2
        ${If} $2 == 2
          StrCpy $ErrorMessage "已安装更新版本，请使用已安装的 XwX Deck。"
        ${EndIf}
      ${Else}
        StrCpy $ErrorMessage "旧版登记暂不可用，请点击下方管理旧版安装。"
      ${EndIf}
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
  StrCpy $InitError $ErrorMessage
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
  Delete "$PLUGINSDIR\target-error.txt"
  ClearErrors
  ExecWait '"$PLUGINSDIR\guard.exe" --check-setup-target "$INSTDIR\XwX Deck.exe" --setup-error-file "$PLUGINSDIR\target-error.txt"' $0
  !insertmacro Log "安装目标核对结果：$0"
  ${If} ${Errors}
  ${OrIf} $0 != 0
    StrCpy $ErrorMessage "无法完成安装检查，请重新打开本安装包后重试。"
    FileOpen $1 "$PLUGINSDIR\target-error.txt" r
    ${IfNot} ${Errors}
      FileReadUTF16LE $1 $ErrorMessage
      FileClose $1
    ${EndIf}
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
  ${If} $LegacyInstall == 1
    ${NSD_CreateLabel} 225 140 363 34 "已找到旧版程序，将保留配置和数据并完成升级。"
    Pop $0
    System::Call /NOUNLOAD '$PLUGINSDIR\XwXSetupSkin.dll::Field(p $0, i 7)'
  ${ElseIf} $ErrorMessage != ""
    ${NSD_CreateLink} 225 158 363 20 "打开系统应用管理"
    Pop $LegacyLink
    System::Call /NOUNLOAD '$PLUGINSDIR\XwXSetupSkin.dll::Field(p $LegacyLink, i 8)'
    ${NSD_OnClick} $LegacyLink ManageLegacyInstallation
  ${EndIf}
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:$OperationName"
  nsDialogs::Show
FunctionEnd

Function ManageLegacyInstallation
  ExecShell "open" "ms-settings:appsfeatures"
FunctionEnd

Function Browse
  ${NSD_GetText} $LocationField $INSTDIR
  SetCtlColors $ErrorLabel 777777 FFFFFF
  ${NSD_SetText} $ErrorLabel "正在打开系统文件夹窗口…"
  ShowWindow $ErrorLabel ${SW_SHOW}
  System::Call 'user32::UpdateWindow(p $ErrorLabel)'
  System::Call /NOUNLOAD '$PLUGINSDIR\XwXSetupSkin.dll::ChooseFolder(p $HWNDPARENT, w "$INSTDIR", w .r0, i ${NSIS_MAX_STRLEN}) i .r1'
  System::Call /NOUNLOAD '$PLUGINSDIR\XwXSetupSkin.dll::FolderOpenMilliseconds() i .r2'
  !insertmacro Log "系统文件夹窗口显示耗时：$2 ms；结果：$1"
  SetCtlColors $ErrorLabel A63429 FFFFFF
  ${NSD_SetText} $ErrorLabel $ErrorMessage
  ${If} $ErrorMessage == ""
    ShowWindow $ErrorLabel ${SW_HIDE}
  ${EndIf}
  ${If} $1 == 1
    StrCpy $INSTDIR $0
    ${NSD_SetText} $LocationField $INSTDIR
  ${ElseIf} $1 == -1
    ${NSD_SetText} $ErrorLabel "无法打开系统文件夹窗口，请直接编辑安装路径后重试。"
    ShowWindow $ErrorLabel ${SW_SHOW}
  ${EndIf}
FunctionEnd

Function InstallLeave
  ${NSD_GetText} $LocationField $INSTDIR
  ${If} $InitError != ""
    ; Re-read after the user handles an unknown installation in Windows Settings.
    Call ReadInstallation
  ${EndIf}
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
  !insertmacro Status "检查安装位置…"
  Call ValidateTarget
  ${If} $ErrorMessage != ""
    !insertmacro Log "$ErrorMessage"
    SetErrorLevel 2
    Abort
  ${EndIf}
  ${If} $LegacyInstall == 1
    IfFileExists "$INSTDIR\.xwx-deck-new.exe" legacy_prepare_failed
    IfFileExists "$INSTDIR\.xwx-deck-old.exe" legacy_prepare_failed
    IfFileExists "$INSTDIR\.xwx-deck-old-uninstall.exe" legacy_prepare_failed
    !insertmacro Status "正在移除旧版程序，保留配置和数据…"
    !insertmacro Log "升级旧版 Windows Installer：$PreviousPath"
    ClearErrors
    ExecWait '"$PLUGINSDIR\guard.exe" --remove-legacy-setup "$PreviousPath\XwX Deck.exe"' $0
    ${If} ${Errors}
    ${OrIf} $0 != 0
      SetErrorLevel 2
      Abort "旧版升级未完成，请重试。旧位置：$PreviousPath。也可在系统设置的已安装应用中管理 XwX Deck。"
    ${EndIf}
    ; MSI owns its own uninstall transaction. The following NSIS transaction is a fresh install.
    DeleteRegKey HKCU "${KEY}"
    StrCpy $PreviousPath ""
    StrCpy $PreviousVersion ""
    StrCpy $PreviousHash ""
    StrCpy $PreviousSize 0
    StrCpy $LegacyInstall 0
    Goto legacy_prepared
legacy_prepare_failed:
    SetErrorLevel 2
    Abort "旧目录存在未完成的恢复文件，请保留旧目录并重试。旧版程序和数据未变。"
legacy_prepared:
  ${EndIf}
  StrCpy $OwnStaging 0
  StrCpy $OwnNewApp 0
  StrCpy $OwnNewUninstaller 0
  StrCpy $Stage 1
  ClearErrors
  CreateDirectory "$INSTDIR"
  SetOutPath "$INSTDIR"
  !insertmacro Log "准备程序文件"
  !insertmacro Status "准备程序文件…"
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
  !insertmacro Status "正在$OperationName…"
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
  !insertmacro Status "正在完成安装…"
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
  SetAutoClose true
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
  !insertmacro Status "正在卸载…"
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
