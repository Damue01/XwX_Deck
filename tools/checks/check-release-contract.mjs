import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {editionBuild} from '../native/edition/build.mjs';
import {checkEditionRelease} from '../native/edition/release-contract.mjs';
const root=resolve(import.meta.dirname,'../..');
const read=path=>readFile(resolve(root,path),'utf8');
const failures=[];
const check=(condition,message)=>{if(!condition)failures.push(message);};
const [contract,pkg,tauri,cargo,core,main,settings,config,host,updates,builder,licenses]=await Promise.all([
 read('release-contract.json').then(JSON.parse),read('package.json').then(JSON.parse),read('src-native/tauri.conf.json').then(JSON.parse),
 read('src-native/Cargo.toml'),read('src-native/src/core.rs'),read('src-native/src/main.rs'),read('src-native/src/settings.rs'),read('src-native/src/edition/config.rs'),read('src-native/src/edition/mod.rs'),read('src-native/src/updates.rs'),read('tools/native/build.mjs'),read('tools/native/license-document.mjs')]);
check(contract.schemaVersion===1&&contract.product==='XwX Deck','product release contract');
check(pkg.displayName===contract.product&&tauri.productName===contract.product,'native product name');
check(tauri.identifier===contract.identity.appId&&tauri.version===pkg.version&&cargo.includes('version = "'+pkg.version+'"'),'native identity and version');
check(cargo.includes('name = "'+editionBuild.nativeBinary+'"')&&builder.includes('editionBuild.nativeBinary'),'native executable identity');
const namespace=contract.identity.dataNamespace??contract.identity.dataDirectory;
check(new RegExp('DATA_DIRECTORY\\s*:\\s*&str\\s*=\\s*"'+namespace+'"').test(config)&&host.includes('config::DATA_DIRECTORY'),'edition data namespace');
check(new RegExp('GATEWAY_PORT\\s*:\\s*u16\\s*=\\s*'+contract.identity.gatewayPort).test(config)&&core.includes('crate::edition::config::GATEWAY_PORT')&&core.includes('bind_gateway_listener(gateway_listen_port(self.isolated))'),'fixed edition Gateway port');
check(pkg.scripts.compile.includes('check:release-contract')&&pkg.scripts.compile.includes('check:runtime-boundary')&&pkg.scripts.compile.includes('check:shared-parity'),'compile executes native and shared-source gates');
check(pkg.scripts['build:win'].includes('tools/native/build.mjs')&&pkg.scripts['build:win'].includes('--require-platform=win32'),'Windows uses guarded native builder');
check(builder.includes('renderLicenseDocument')&&licenses.includes('meta charset="utf-8"')&&main.includes('licenses.html'),'native license document');
check(updates.includes('declined-update.json')&&/latest\s*!=\s*selected/.test(updates)&&updates.includes('SHA-256'),'immutable updates, cancellation and digest verification');
check(builder.includes('buildWindowsSetup')&&main.includes('windows_setup::spawn')&&main.includes('portable_update::spawn'),'separate installer and portable updates');
check(!pkg.dependencies?.electron&&!pkg.devDependencies?.electron&&!pkg.devDependencies?.['electron-builder'],'Rust is the default runtime');
check(core.includes('extension::call')&&main.includes('edition::rpc'),'edition features use extension dispatch');
await checkEditionRelease({read,check,contract,pkg,tauri,cargo,core,main,settings,config,host,updates,builder});
if(failures.length){console.error(failures.map(message=>'- '+message).join('\n'));process.exitCode=1;}else console.log('PASS native release identity, storage, Gateway, packaging, update and extension contract');
