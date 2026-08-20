import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { transform } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const input = resolve(root, "src/renderer/styles.css");
const output = resolve(root, "dist/renderer/app.css");

const css = await readFile(input, "utf8");
const result = await postcss([tailwind()]).process(css, {
  from: input,
  to: output,
});

// Inline @fontsource font files as base64 data URIs. The packaged app has no
// node_modules, so the relative url(../../node_modules/...) refs would 404 and
// the custom font would silently fall back to a system one.
let outCss = result.css;
const urlRe = /url\(([^)]+\.woff2)\)/g;
const seen = new Map();
const matches = [...outCss.matchAll(urlRe)];
for (const m of matches) {
  const raw = m[1].replace(/^['"]|['"]$/g, "").trim();
  if (raw.startsWith("data:")) continue;
  if (!seen.has(raw)) {
    const abs = resolve(dirname(output), raw);
    if (existsSync(abs)) {
      const buf = await readFile(abs);
      seen.set(raw, `data:font/woff2;base64,${buf.toString("base64")}`);
    } else {
      seen.set(raw, null);
    }
  }
  const dataUri = seen.get(raw);
  if (dataUri) outCss = outCss.split(m[0]).join(`url(${dataUri})`);
}

if (process.argv.includes("--minify")) {
  outCss = (await transform(outCss, { loader: "css", minify: true, target: "chrome120" })).code;
}

await mkdir(dirname(output), { recursive: true });
await writeFile(output, outCss, "utf8");
console.log(`[renderer-css] wrote ${output} (${outCss.length} bytes, ${seen.size} font(s) inlined)`);
