import {writeFile,cp} from 'node:fs/promises';
import {resolve} from 'node:path';
export async function writeInstallGuide({root,guide,isolated,acceptance,signed}){
    if (isolated) {
      await writeFile(guide, 'XwX Deck 隔离验证包\n\n本包使用独立身份和测试配置。请在源码仓库运行 npm run start:native:isolated。不要替换正常应用。\n\n本地验证不代表正式发布、签名或公证验收。\n');
    } else {
      await cp(resolve(root, 'assets/macos/首次打开说明.txt'), guide);
    }

}
