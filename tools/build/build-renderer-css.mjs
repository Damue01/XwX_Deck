import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { transform } from "esbuild";
import { sharedFontCss } from './inline-font-css.mjs';

const root = resolve(import.meta.dirname, "..", "..");
const input = resolve(root, "src/renderer/styles.css");
const output = resolve(root, "dist/renderer/app.css");

const css = await readFile(input, "utf8");
const result = await postcss([tailwind()]).process(css, {
  from: input,
  to: output,
});

// Browser previews serve these files normally. Native preparation embeds the
// same files once in Rust and routes both windows to that shared resource set.
let outCss = await sharedFontCss(result.css, output, resolve(dirname(output), 'fonts'));

if (process.argv.includes("--minify")) {
  outCss = (await transform(outCss, { loader: "css", minify: true, target: "chrome120" })).code;
}

await mkdir(dirname(output), { recursive: true });
await writeFile(output, outCss, "utf8");
console.log(`[renderer-css] wrote ${output} (${outCss.length} bytes; shared offline fonts)`);
