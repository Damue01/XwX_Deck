import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { inlineFontCss, sharedFontCss } from './inline-font-css.mjs';

export const createRawTextPlugin = ({ sharedFonts = false } = {}) => ({
  name: 'raw-text',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, args => ({
      path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
      namespace: 'raw-text'
    }));
    build.onLoad({ filter: /.*/, namespace: 'raw-text' }, async args => {
      let contents = await readFile(args.path, 'utf8');
      if (path.basename(args.path) === 'typography.css') contents = await (sharedFonts ? sharedFontCss : inlineFontCss)(contents, args.path);
      return { contents, loader: 'text' };
    });
  }
});
// Standalone HTML exports retain their self-contained font resources.
export const rawTextPlugin = createRawTextPlugin();
