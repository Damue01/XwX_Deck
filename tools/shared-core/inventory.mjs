import {readdir,lstat} from 'node:fs/promises';
import {join} from 'node:path';
export const isEditionPath = path => path === 'src/shared/edition.ts' || ['src/shared/edition/', 'src/renderer/edition/', 'src-native/src/edition/', 'tools/native/edition/'].some(prefix => path.startsWith(prefix));
export async function runtimeFiles(root){
 const files=[];
 async function visit(dir){for(const item of await readdir(join(root,dir),{withFileTypes:true})){const path=dir+'/'+item.name;if(isEditionPath(path))continue;const meta=await lstat(join(root,path));if(meta.isSymbolicLink())throw Error('Runtime path must be a regular file or directory: '+path);if(item.isDirectory())await visit(path);else if(item.isFile())files.push(path);}}
 for(const dir of ['src','src-native/src'])await visit(dir);
 return files.sort();
}
export async function assertRuntimeInventory(root,entries){const names=new Set(entries.map(e=>e.path));for(const path of await runtimeFiles(root))if(!names.has(path))throw Error('Common runtime file is not registered: '+path);}
