import { join } from 'node:path';
const xml = value => String(value).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
/** Branded MSI dialogs reuse the approved macOS Trace artwork. */
export function windowsMsiUi(root) {
  const bitmap = (id,file) => `<Binary Id="${id}" SourceFile="${xml(join(root,'assets/windows-installer',file))}" />`;
  const background = `<Control Id="Background" Type="Bitmap" X="0" Y="0" Width="520" Height="300" Text="DeckBackground" TabSkip="yes" />`;
  const surface = (width,height) => `<Control Id="Surface" Type="Bitmap" X="0" Y="0" Width="${width}" Height="${height}" Text="DeckSurface" TabSkip="yes" />`;
  const title = text => `<Control Id="Heading" Type="Text" X="30" Y="24" Width="460" Height="32" Transparent="yes" NoPrefix="yes" Text="{\\DeckTitle}${text}" />`;
  const text = (id,value,y=220) => `<Control Id="${id}" Type="Text" X="30" Y="${y}" Width="460" Height="28" Transparent="yes" NoPrefix="yes" Text="${value}" />`;
  const button = (id,label,x,events,extra='') => `<Control Id="${id}" Type="PushButton" X="${x}" Y="268" Width="76" Height="22" Text="${label}" ${extra}>${events}</Control>`;
  const publish = (event,value,condition='1') => `<Publish Event="${event}" Value="${value}">${condition}</Publish>`;
  const cancel = button('Cancel','取消',332,publish('SpawnDialog','DeckCancel'),'Cancel="yes"');
  const scene = `<Control Id="App" Type="Bitmap" X="96" Y="85" Width="68" Height="68" Text="DeckApp" TabSkip="yes" />
    <Control Id="Folder" Type="Bitmap" X="356" Y="85" Width="68" Height="68" Text="DeckFolder" TabSkip="yes" />
    <Control Id="AppLabel" Type="Text" X="104" Y="168" Width="120" Height="16" Transparent="yes" Text="XwX Deck" />
    <Control Id="FolderLabel" Type="Text" X="370" Y="168" Width="140" Height="16" Transparent="yes" Text="应用程序" />`;
  const terminal = (id,heading,body,onExit) => `<Dialog Id="${id}" Width="520" Height="300" Title="XwX Deck" NoMinimize="yes">
    ${background}${title(heading)}${scene}${text('Description',body)}
    ${button('Finish','完成',414,publish('EndDialog','Return'),'Default="yes" Cancel="yes"')}
    </Dialog><InstallUISequence><Show Dialog="${id}" OnExit="${onExit}" /></InstallUISequence><AdminUISequence><Show Dialog="${id}" OnExit="${onExit}" /></AdminUISequence>`;
  return `${bitmap('DeckBackground','trace-background.bmp')}${bitmap('DeckApp','app.bmp')}${bitmap('DeckFolder','folder.bmp')}${bitmap('DeckSurface','surface.bmp')}
  <Property Id="ARPNOMODIFY" Value="1" />
  <UI Id="DeckInstallerUI">
   <TextStyle Id="DeckNormal" FaceName="Microsoft YaHei UI" Size="10" Red="25" Green="26" Blue="24" />
   <TextStyle Id="DeckTitle" FaceName="Microsoft YaHei UI" Size="20" Bold="yes" Red="25" Green="26" Blue="24" />
   <Property Id="DefaultUIFont" Value="DeckNormal" />
   <Dialog Id="DeckWelcome" Width="520" Height="300" Title="安装 XwX Deck" NoMinimize="yes">
    ${background}${title('XwX Deck')}${scene}
    ${text('LocationLabel','安装位置',204)}
    <Control Id="Location" Type="PathEdit" X="30" Y="228" Width="370" Height="20" Property="INSTALLDIR" Indirect="no" />
    <Control Id="Browse" Type="PushButton" X="414" Y="228" Width="76" Height="20" Text="更改…">${publish('SpawnDialog','DeckBrowse')}</Control>
    ${cancel}
    ${button('Install','安装',414,publish('SetTargetPath','INSTALLDIR')+publish('EndDialog','Return'),'Default="yes"')}
   </Dialog>
   <Dialog Id="DeckBrowse" Width="360" Height="260" Title="选择安装位置" NoMinimize="yes">
    ${surface(360,260)}
    <Control Id="Folder" Type="DirectoryCombo" X="20" Y="20" Width="320" Height="20" Property="INSTALLDIR" />
    <Control Id="Folders" Type="DirectoryList" X="20" Y="50" Width="320" Height="145" Property="INSTALLDIR" />
    <Control Id="Path" Type="PathEdit" X="20" Y="202" Width="320" Height="20" Property="INSTALLDIR" />
    <Control Id="Cancel" Type="PushButton" X="184" Y="230" Width="74" Height="20" Text="取消" Cancel="yes">${publish('Reset','0')}${publish('EndDialog','Return')}</Control>
    <Control Id="Choose" Type="PushButton" X="266" Y="230" Width="74" Height="20" Text="选择" Default="yes">${publish('SetTargetPath','INSTALLDIR')}${publish('EndDialog','Return')}</Control>
   </Dialog>
   <Dialog Id="DeckMaintenance" Width="520" Height="300" Title="XwX Deck" NoMinimize="yes">
    ${background}${title('XwX Deck')}${scene}${text('Description','修复程序文件，或卸载应用。配置和数据保留。')}
    ${button('Cancel','取消',250,publish('EndDialog','Exit'),'Cancel="yes"')}
    ${button('Repair','修复',332,'<Publish Property="REINSTALL" Value="ALL">1</Publish><Publish Property="REINSTALLMODE" Value="amus">1</Publish>'+publish('EndDialog','Return'))}
    ${button('Remove','卸载',414,'<Publish Property="REMOVE" Value="ALL">1</Publish>'+publish('EndDialog','Return'),'Default="yes"')}
   </Dialog>
   <Dialog Id="DeckProgress" Width="520" Height="300" Title="XwX Deck" Modeless="yes">
    ${background}${title('XwX Deck')}${scene}
    <Control Id="ActionText" Type="Text" X="30" Y="215" Width="460" Height="32" Transparent="yes" Text="正在准备安装…"><Subscribe Event="ActionText" Attribute="Text" /></Control>
    <Control Id="Progress" Type="ProgressBar" X="30" Y="251" Width="460" Height="6" ProgressBlocks="no"><Subscribe Event="SetProgress" Attribute="Progress" /></Control>
    ${cancel}
   </Dialog>
   <Dialog Id="DeckCancel" Width="320" Height="130" Title="XwX Deck" NoMinimize="yes">
    ${surface(320,130)}
    <Control Id="Question" Type="Text" X="20" Y="22" Width="280" Height="32" Text="取消本次安装？现有配置和数据保留。" />
    <Control Id="Continue" Type="PushButton" X="140" Y="90" Width="76" Height="22" Text="继续安装" Default="yes" Cancel="yes">${publish('EndDialog','Return')}</Control>
    <Control Id="Cancel" Type="PushButton" X="224" Y="90" Width="76" Height="22" Text="取消安装">${publish('EndDialog','Exit')}</Control>
   </Dialog>
   <Dialog Id="DeckError" Width="420" Height="180" Title="XwX Deck" ErrorDialog="yes" NoMinimize="yes">
    ${surface(420,180)}
    <Control Id="ErrorText" Type="Text" X="22" Y="24" Width="376" Height="112" TabSkip="no" NoPrefix="yes" Text="[ErrorText]" />
    ${[['Y','是','ErrorYes'],['A','停止','ErrorAbort'],['C','取消','ErrorCancel'],['I','忽略','ErrorIgnore'],['N','否','ErrorNo'],['O','确定','ErrorOk'],['R','重试','ErrorRetry']].map(([id,label,event])=>`<Control Id="${id}" Type="PushButton" X="300" Y="145" Width="96" Height="22" TabSkip="yes" Text="${label}">${publish('EndDialog',event)}</Control>`).join('')}
   </Dialog>
   <Property Id="ErrorDialog" Value="DeckError" />
   <Dialog Id="FilesInUse" Width="420" Height="210" Title="XwX Deck" NoMinimize="yes">
    ${surface(420,210)}
    <Control Id="Message" Type="Text" X="22" Y="20" Width="376" Height="35" Text="程序文件正在使用。请从托盘退出应用后重试。" />
    <Control Id="List" Type="ListBox" X="22" Y="62" Width="376" Height="92" Property="FileInUseProcess" Sunken="yes" />
    <Control Id="Exit" Type="PushButton" X="230" Y="174" Width="76" Height="22" Text="取消" Cancel="yes">${publish('EndDialog','Exit')}</Control>
    <Control Id="Ignore" Type="PushButton" X="22" Y="174" Width="76" Height="22" Text="忽略" Hidden="yes" Disabled="yes" TabSkip="yes">${publish('EndDialog','Ignore')}</Control>
    <Control Id="Retry" Type="PushButton" X="322" Y="174" Width="76" Height="22" Text="重试" Default="yes">${publish('EndDialog','Retry')}</Control>
   </Dialog>
   <Dialog Id="MsiRMFilesInUse" Width="420" Height="210" Title="XwX Deck" KeepModeless="yes" NoMinimize="yes">
    ${surface(420,210)}
    <Control Id="Message" Type="Text" X="22" Y="20" Width="376" Height="35" Text="程序文件正在使用。请从托盘退出应用后重试。" />
    <Control Id="List" Type="ListBox" X="22" Y="62" Width="376" Height="92" Property="FileInUseProcess" Sunken="yes" TabSkip="yes" />
    <Control Id="Cancel" Type="PushButton" X="230" Y="174" Width="76" Height="22" Text="取消" Cancel="yes">${publish('EndDialog','Exit')}</Control>
    <Control Id="Retry" Type="PushButton" X="322" Y="174" Width="76" Height="22" Text="重试" Default="yes">${publish('EndDialog','Return')}</Control>
   </Dialog>
   ${terminal('DeckComplete','已完成','配置和数据保持不变。','success')}
   ${terminal('DeckFailed','安装未完成','未完成安装。现有配置和数据保留。','error')}
   ${terminal('DeckCancelled','已取消','本次操作已取消。现有配置和数据保留。','cancel')}
   <ProgressText Action="InstallValidate">检查程序文件</ProgressText>
   <ProgressText Action="InstallInitialize">准备安装</ProgressText>
   <ProgressText Action="InstallFiles">安装程序文件</ProgressText>
   <ProgressText Action="RemoveFiles">移除旧程序文件</ProgressText>
   <ProgressText Action="CreateShortcuts">创建快捷方式</ProgressText>
   <ProgressText Action="WriteRegistryValues">登记当前用户安装</ProgressText>
   <ProgressText Action="InstallFinalize">正在完成，请稍候…</ProgressText>
   <InstallUISequence>
    <Show Dialog="DeckWelcome" After="CostFinalize">NOT Installed</Show>
    <Show Dialog="DeckMaintenance" After="DeckWelcome">Installed AND NOT RESUME</Show>
    <Show Dialog="DeckProgress" Before="ExecuteAction" />
   </InstallUISequence>
  </UI>`;
}
