// Build a genuinely older native executable in an isolated source copy.
import { cp, copyFile, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve, join } from 'node:path';
import { rustToolchain } from './toolchain.mjs';

if(process.platform!=='win32')throw Error('Windows fixture requires Windows.');
const root=resolve(import.meta.dirname,'../..'),version='0.9.9';
const fixture=await mkdtemp(join(root,'test-results/setup-version-fixture-'));
for(const directory of ['src-native','src/shared','tools/native','assets','test-results/native-assets','test-results/native-frontend'])await cp(join(root,directory),join(fixture,directory),{recursive:true});
await copyFile(join(root,'release-contract.json'),join(fixture,'release-contract.json'));
for(const file of ['Cargo.toml','Cargo.lock','tauri.conf.json']){
 const path=join(fixture,'src-native',file);let source=await readFile(path,'utf8');
 source=file==='Cargo.lock'?source.replace(/(name = "xwx-deck-native"\r?\nversion = ")[^"]+/, '$1'+version):source.replace(/(version\s*[=:]\s*")[^"]+/, '$1'+version);
 if(file==='tauri.conf.json'){const config=JSON.parse(source);config.version=version;source=JSON.stringify(config,null,2)+'\n';}
 await writeFile(path,source);
}
const {cargo,env}=rustToolchain(root);
const child=spawn(cargo,['build','--locked','--manifest-path',join(fixture,'src-native/Cargo.toml')],{env,stdio:'inherit',windowsHide:true});
const [code]=await once(child,'exit');if(code)process.exit(code);
const output=resolve(process.argv.find(arg=>arg.startsWith('--output='))?.slice(9)||join(fixture,'old.exe'));
await mkdir(resolve(output,'..'),{recursive:true});await copyFile(join(env.CARGO_TARGET_DIR,'debug/xwx-deck-native.exe'),output);
await writeFile(output+'.fixture.json',JSON.stringify({version,fixture,binary:output,scope:'isolated test executable; not a release'},null,2)+'\n');
console.log(output);
