import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const rawTextPlugin = {
  name: 'raw-text',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, args => ({
      path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
      namespace: 'raw-text'
    }));
    build.onLoad({ filter: /.*/, namespace: 'raw-text' }, async args => ({
      contents: await readFile(args.path, 'utf8'),
      loader: 'text'
    }));
  }
};
