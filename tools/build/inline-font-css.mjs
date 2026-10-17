import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Content names let both native surfaces address exactly the same embedded bytes.
export async function sharedFontCss(css, from, directory) {
  const urls = [...new Set([...css.matchAll(/url\(([^)]+\.woff2)\)/g)].map(match => match[1]))];
  if (directory) await mkdir(directory, { recursive: true });
  for (const url of urls) {
    const path = url.replace(/^['"]|['"]$/g, '').trim();
    if (/^(?:data:|https?:)/.test(path)) throw new Error('Expected a bundled local font: ' + path);
    const bytes = await readFile(resolve(dirname(from), path));
    const name = createHash('sha256').update(bytes).digest('hex') + '.woff2';
    if (directory) await writeFile(resolve(directory, name), bytes);
    css = css.replaceAll(`url(${url})`, `url(/fonts/${name})`);
  }
  return css;
}

// The dashboard is a self-contained local document. Keep its font resources
// offline too, without adding a network service or runtime font dependency.
export async function inlineFontCss(css, from) {
  const urls = [...new Set([...css.matchAll(/url\(([^)]+\.woff2)\)/g)].map(match => match[1]))];
  for (const url of urls) {
    const path = url.replace(/^['"]|['"]$/g, '').trim();
    if (/^(?:data:|https?:)/.test(path)) throw new Error('Expected a bundled local font: ' + path);
    const bytes = await readFile(resolve(dirname(from), path));
    css = css.replaceAll(`url(${url})`, `url(data:font/woff2;base64,${bytes.toString('base64')})`);
  }
  return css;
}
