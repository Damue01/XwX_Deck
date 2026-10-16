import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { inlineFontCss } from './inline-font-css.mjs';

export const rawTextPlugin = {
  name: 'raw-text',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, args => ({
      path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
      namespace: 'raw-text'
    }));
    build.onLoad({ filter: /.*/, namespace: 'raw-text' }, async args => {
      let contents = await readFile(args.path, 'utf8');
      if (path.basename(args.path) === 'typography.css') contents = await inlineFontCss(contents, args.path);
      return { contents, loader: 'text' };
    });
  }
};
