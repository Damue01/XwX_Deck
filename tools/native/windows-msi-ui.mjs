import { join } from 'node:path';

const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** Windows installation and maintenance, without Finder or drag gestures. */
export function windowsMsiUi(root) {
  const event = (name, value, condition = '1') => `<Publish Event="${name}" Value="${xml(value)}">${xml(condition)}</Publish>`;
  const set = (name, value) => `<Publish Property="${name}" Value="${value}">1</Publish>`;
  const when = condition => `<Condition Action="show">${xml(condition)}</Condition><Condition Action="hide">${xml(`NOT (${condition})`)}</Condition>`;
  const text = (id, value, y, height = 28, condition) => `<Control Id="${id}" Type="Text" X="28" Y="${y}" Width="424" Height="${height}" Transparent="yes" NoPrefix="yes" Text="${xml(value)}">${condition ? when(condition) : ''}</Control>`;
  const heading = (id, value, condition) => text(id, `{\\DeckTitle}${value}`, 79, 34, condition);
  const surface = (width, height) => `<Control Id="Surface" Type="Bitmap" X="0" Y="0" Width="${width}" Height="${height}" Text="DeckSurface" TabSkip="yes" />`;
  const shell = `${surface(480, 300)}
    <Control Id="BrandIcon" Type="Bitmap" X="28" Y="26" Width="25" Height="25" Text="DeckApp" TabSkip="yes" />
    <Control Id="Brand" Type="Text" X="64" Y="29" Width="250" Height="24" Transparent="yes" Text="{\\DeckBrand}XwX Deck" />
    <Control Id="Version" Type="Text" X="348" Y="32" Width="104" Height="16" RightAligned="yes" Transparent="yes" Text="[ProductVersion]" />`;
  const button = (id, label, x, events, extra = '', condition) => `<Control Id="${id}" Type="PushButton" X="${x}" Y="264" Width="80" Height="22" Text="${label}" ${extra}>${events}${condition ? when(condition) : ''}</Control>`;
  const cancel = button('Cancel', '取消', 284, event('SpawnDialog', 'DeckCancel'), 'Cancel="yes"');
  const back = button('Back', '上一步', 196, event('NewDialog', 'DeckMaintenance'), '', 'NOT DECK_COMMAND_MAINTENANCE');
  const states = suffix => [
    ['Install', '安装', 'NOT REMOVE AND NOT REINSTALL AND NOT WIX_UPGRADE_DETECTED'],
    ['Upgrade', '更新', 'NOT REMOVE AND NOT REINSTALL AND WIX_UPGRADE_DETECTED'],
    ['Repair', '修复', 'NOT REMOVE AND REINSTALL'],
    ['Remove', '卸载', 'REMOVE="ALL"'],
  ].map(([id, label, condition]) => heading(id + 'Heading', suffix ? label + suffix : '正在' + label, condition)).join('');
  const terminal = (id, title, body, exit) => `<Dialog Id="${id}" Width="480" Height="300" Title="XwX Deck 安装程序" NoMinimize="yes">
    ${shell}${heading('Heading', title)}${text('Description', body, 130, 44)}${text('Log', '安装日志：[MsiLogFileLocation]', 184, 64)}
    ${button('Finish', '关闭', 372, event('EndDialog', 'Return'), 'Default="yes" Cancel="yes"')}
    </Dialog><InstallUISequence><Show Dialog="${id}" OnExit="${exit}" /></InstallUISequence><AdminUISequence><Show Dialog="${id}" OnExit="${exit}" /></AdminUISequence>`;

  return `<Binary Id="DeckApp" SourceFile="${xml(join(root, 'assets/windows-installer/app.bmp'))}" />
  <Binary Id="DeckSurface" SourceFile="${xml(join(root, 'assets/windows-installer/surface.bmp'))}" />
  <Binary Id="DeckErrorIcon" SourceFile="${xml(join(root, 'assets/icon.ico'))}" />
  <Property Id="ARPNOMODIFY" Value="1" />
  <Property Id="DECK_LAUNCH_APP" Value="1" />
  <Property Id="DECK_INSTALL_BUTTON" Value="安装" />
  <SetProperty Id="DECK_INSTALL_BUTTON" Value="更新" Before="CostFinalize" Sequence="ui">WIX_UPGRADE_DETECTED</SetProperty>
  <SetProperty Id="DECK_COMMAND_MAINTENANCE" Value="1" Before="CostFinalize" Sequence="ui">Installed AND (REMOVE="ALL" OR REINSTALL)</SetProperty>
  <UI Id="DeckInstallerUI">
   <TextStyle Id="DeckNormal" FaceName="Microsoft YaHei UI" Size="10" Red="25" Green="26" Blue="24" />
   <TextStyle Id="DeckBrand" FaceName="Microsoft YaHei UI" Size="12" Bold="yes" Red="25" Green="26" Blue="24" />
   <TextStyle Id="DeckTitle" FaceName="Microsoft YaHei UI" Size="19" Bold="yes" Red="25" Green="26" Blue="24" />
   <Property Id="DefaultUIFont" Value="DeckNormal" />
   <Dialog Id="DeckWelcome" Width="480" Height="300" Title="安装 XwX Deck" NoMinimize="yes">
    ${shell}${heading('InstallHeading', '安装 XwX Deck', 'NOT WIX_UPGRADE_DETECTED')}${heading('UpgradeHeading', '更新 XwX Deck', 'WIX_UPGRADE_DETECTED')}
    ${text('Scope', '仅为当前 Windows 用户安装。', 124, 22, 'NOT WIX_UPGRADE_DETECTED')}
    ${text('UpgradeDescription', '更新现有安装，保留配置、账号和 Trace 数据。', 124, 22, 'WIX_UPGRADE_DETECTED')}
    ${text('LocationLabel', '安装位置', 157, 18)}
    <Control Id="Location" Type="PathEdit" X="28" Y="181" Width="336" Height="22" Property="INSTALLDIR">${when('NOT WIX_UPGRADE_DETECTED')}</Control>
    <Control Id="Browse" Type="PushButton" X="372" Y="181" Width="80" Height="22" Text="浏览…">${event('SpawnDialog', 'DeckBrowse')}${when('NOT WIX_UPGRADE_DETECTED')}</Control>
    ${text('ExistingLocation', '[INSTALLDIR]', 181, 34, 'WIX_UPGRADE_DETECTED')}
    ${text('StartMenu', '将在开始菜单创建入口。', 219, 28, 'NOT WIX_UPGRADE_DETECTED')}
    ${text('UpgradeLocation', '沿用已有安装位置。更换位置请先卸载再安装。', 219, 28, 'WIX_UPGRADE_DETECTED')}
    ${cancel}
    ${button('Install', '[DECK_INSTALL_BUTTON]', 372, event('SetTargetPath', 'INSTALLDIR', 'NOT WIX_UPGRADE_DETECTED') + event('EndDialog', 'Return'), 'Default="yes"')}
   </Dialog>
   <Dialog Id="DeckBrowse" Width="400" Height="300" Title="选择安装位置" NoMinimize="yes">
    ${surface(400, 300)}
    <Control Id="Folder" Type="DirectoryCombo" X="20" Y="20" Width="360" Height="70" Property="INSTALLDIR" Fixed="yes" Remote="yes" />
    <Control Id="Up" Type="PushButton" X="20" Y="51" Width="80" Height="20" Text="上一级">${event('DirectoryListUp', '0')}</Control>
    <Control Id="NewFolder" Type="PushButton" X="108" Y="51" Width="80" Height="20" Text="新建文件夹">${event('DirectoryListNew', '0')}</Control>
    <Control Id="Folders" Type="DirectoryList" X="20" Y="82" Width="360" Height="133" Property="INSTALLDIR" Sunken="yes" />
    <Control Id="Path" Type="PathEdit" X="20" Y="228" Width="360" Height="22" Property="INSTALLDIR" />
    <Control Id="Cancel" Type="PushButton" X="212" Y="266" Width="80" Height="22" Text="取消" Cancel="yes">${event('Reset', '0')}${event('EndDialog', 'Return')}</Control>
    <Control Id="Choose" Type="PushButton" X="300" Y="266" Width="80" Height="22" Text="选择" Default="yes">${event('SetTargetPath', 'INSTALLDIR')}${event('EndDialog', 'Return')}</Control>
   </Dialog>
   <Dialog Id="DeckMaintenance" Width="480" Height="300" Title="维护 XwX Deck" NoMinimize="yes">
    ${shell}${heading('Heading', '维护 XwX Deck')}${text('Description', '修复程序文件，或卸载当前用户的应用。', 128)}
    ${text('LocationLabel', '安装位置', 167, 18)}${text('Location', '[INSTALLDIR]', 191, 40)}
    ${button('Cancel', '取消', 196, event('EndDialog', 'Exit'), 'Cancel="yes"')}
    ${button('Repair', '修复', 284, event('NewDialog', 'DeckRepair'), 'Default="yes"')}
    ${button('Remove', '卸载', 372, event('NewDialog', 'DeckRemove'))}
   </Dialog>
   ${['Repair', 'Remove'].map(mode => `<Dialog Id="Deck${mode}" Width="480" Height="300" Title="${mode === 'Repair' ? '修复' : '卸载'} XwX Deck" NoMinimize="yes">
    ${shell}${heading('Heading', (mode === 'Repair' ? '修复' : '卸载') + ' XwX Deck')}
    ${text('Description', mode === 'Repair' ? '重新安装程序文件和开始菜单入口。' : '移除程序文件和开始菜单入口。', 128)}
    ${text('Data', '配置、账号、日志和 Trace 数据保留，重装后可继续使用。', 168, 36)}
    ${text('ExitNotice', '请先从托盘退出已安装的 XwX Deck。', 213)}${back}${cancel}
    ${button(mode, mode === 'Repair' ? '修复' : '卸载', 372, (mode === 'Repair' ? set('REINSTALL', 'ALL') + set('REINSTALLMODE', 'amus') : set('REMOVE', 'ALL')) + event('EndDialog', 'Return'), 'Default="yes"')}
   </Dialog>`).join('')}
   <Dialog Id="DeckProgress" Width="480" Height="300" Title="XwX Deck 安装程序" Modeless="yes">
    ${shell}${states('')}
    <Control Id="ActionText" Type="Text" X="28" Y="143" Width="424" Height="36" Transparent="yes" Text="正在检查安装条件…"><Subscribe Event="ActionText" Attribute="Text" /></Control>
    <Control Id="Progress" Type="ProgressBar" X="28" Y="188" Width="424" Height="9" ProgressBlocks="no"><Subscribe Event="SetProgress" Attribute="Progress" /></Control>
    ${text('Data', '配置和数据保留。', 218)}${cancel}
   </Dialog>
   <Dialog Id="DeckComplete" Width="480" Height="300" Title="XwX Deck 安装程序" NoMinimize="yes">
    ${shell}${states('完成')}${text('Location', '[INSTALLDIR]', 130, 40, 'NOT REMOVE')}${text('Data', '配置、账号、日志和 Trace 数据已保留。', 181, 40)}
    <Control Id="Launch" Type="CheckBox" X="28" Y="227" Width="16" Height="16" Property="DECK_LAUNCH_APP" CheckBoxValue="1" Text="启动 XwX Deck">${when('NOT REMOVE AND ACTION="INSTALL"')}</Control>
    <Control Id="LaunchLabel" Type="Text" X="48" Y="226" Width="300" Height="20" Transparent="yes" Text="启动 XwX Deck">${when('NOT REMOVE AND ACTION="INSTALL"')}</Control>
    ${button('Finish', '完成', 372, event('MsiLaunchApp', '[#DeckExecutable]', 'DECK_LAUNCH_APP=1 AND NOT REMOVE AND ACTION="INSTALL"') + event('EndDialog', 'Return'), 'Default="yes" Cancel="yes"')}
   </Dialog>
   <Dialog Id="DeckCancel" Width="340" Height="140" Title="取消操作" NoMinimize="yes">
    ${surface(340, 140)}
    <Control Id="Question" Type="Text" X="20" Y="22" Width="300" Height="50" Text="取消本次操作？已执行的更改将回滚，配置和数据保留。" />
    <Control Id="Continue" Type="PushButton" X="152" Y="102" Width="80" Height="22" Text="继续" Default="yes" Cancel="yes">${event('EndDialog', 'Return')}</Control>
    <Control Id="Cancel" Type="PushButton" X="240" Y="102" Width="80" Height="22" Text="取消操作">${event('EndDialog', 'Exit')}</Control>
   </Dialog>
   <Dialog Id="DeckError" Width="440" Height="210" Title="XwX Deck 安装程序" ErrorDialog="yes" NoMinimize="yes">
    ${surface(440, 210)}
    <Control Id="ErrorIcon" Type="Icon" X="22" Y="24" Width="24" Height="24" FixedSize="yes" IconSize="32" Text="DeckErrorIcon" TabSkip="yes" />
    <Control Id="ErrorText" Type="Text" X="58" Y="24" Width="360" Height="140" TabSkip="no" NoPrefix="yes" Text="[ErrorText]" />
    ${[['Y', '是', 'ErrorYes'], ['A', '停止', 'ErrorAbort'], ['C', '取消', 'ErrorCancel'], ['I', '忽略', 'ErrorIgnore'], ['N', '否', 'ErrorNo'], ['O', '确定', 'ErrorOk'], ['R', '重试', 'ErrorRetry']].map(([id, label, result]) => `<Control Id="${id}" Type="PushButton" X="322" Y="174" Width="96" Height="22" TabSkip="yes" Text="${label}">${event('EndDialog', result)}</Control>`).join('')}
   </Dialog>
   <Property Id="ErrorDialog" Value="DeckError" />
   <Error Id="1722">无法安全更新或卸载。请先从托盘退出已安装的 XwX Deck，再重试。若仍失败，请查看安装日志：[MsiLogFileLocation]</Error>
   ${['FilesInUse', 'MsiRMFilesInUse'].map(id => `<Dialog Id="${id}" Width="440" Height="230" Title="程序正在运行" NoMinimize="yes" ${id === 'MsiRMFilesInUse' ? 'KeepModeless="yes"' : ''}>
    ${surface(440, 230)}
    <Control Id="Message" Type="Text" X="22" Y="20" Width="396" Height="43" Text="请先从托盘退出下列程序，再点重试。安装程序不会强制结束应用。" />
    <Control Id="List" Type="ListBox" X="22" Y="72" Width="396" Height="102" Property="FileInUseProcess" Sunken="yes" TabSkip="yes" />
    <Control Id="Cancel" Type="PushButton" X="242" Y="194" Width="80" Height="22" Text="取消" Cancel="yes">${event('EndDialog', 'Exit')}</Control>
    ${id === 'FilesInUse' ? `<Control Id="Ignore" Type="PushButton" X="22" Y="194" Width="80" Height="22" Text="忽略" Hidden="yes" Disabled="yes" TabSkip="yes">${event('EndDialog', 'Ignore')}</Control>` : ''}
    <Control Id="Retry" Type="PushButton" X="338" Y="194" Width="80" Height="22" Text="重试" Default="yes">${event('EndDialog', id === 'FilesInUse' ? 'Retry' : 'Return')}</Control>
   </Dialog>`).join('')}
   ${terminal('DeckFailed', '操作未完成', '现有配置和数据保留。请查看下方日志，处理错误后重试。', 'error')}
   ${terminal('DeckCancelled', '操作已取消', '本次操作已取消，现有配置和数据保留。', 'cancel')}
   <ProgressText Action="InstallValidate">检查程序文件和磁盘空间</ProgressText>
   <ProgressText Action="InstallInitialize">准备安装事务</ProgressText>
   <ProgressText Action="InstallFiles">安装程序文件</ProgressText>
   <ProgressText Action="RemoveFiles">移除程序文件</ProgressText>
   <ProgressText Action="CreateShortcuts">创建开始菜单入口</ProgressText>
   <ProgressText Action="RemoveShortcuts">移除开始菜单入口</ProgressText>
   <ProgressText Action="WriteRegistryValues">登记当前用户安装</ProgressText>
   <ProgressText Action="InstallFinalize">正在完成，请稍候…</ProgressText>
   <InstallUISequence>
    <Show Dialog="DeckWelcome" After="CostFinalize">NOT Installed</Show>
    <Show Dialog="DeckRemove" After="DeckWelcome">Installed AND DECK_COMMAND_MAINTENANCE AND REMOVE="ALL"</Show>
    <Show Dialog="DeckRepair" After="DeckRemove">Installed AND DECK_COMMAND_MAINTENANCE AND REINSTALL AND NOT REMOVE</Show>
    <Show Dialog="DeckMaintenance" After="DeckRepair">Installed AND NOT DECK_COMMAND_MAINTENANCE AND NOT RESUME</Show>
    <Show Dialog="DeckProgress" Before="ExecuteAction" />
    <Show Dialog="DeckComplete" OnExit="success" />
   </InstallUISequence>
   <AdminUISequence><Show Dialog="DeckComplete" OnExit="success" /></AdminUISequence>
  </UI>`;
}
