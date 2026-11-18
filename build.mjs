// Builds (1) dist/index.html — standalone, opens offline in any browser,
//        (2) dist/ArbDashboard.artifact.jsx — single file to paste into a Claude React artifact.
import fs from "node:fs";
import { build } from "esbuild";
fs.mkdirSync("dist", { recursive: true });
const r = await build({ entryPoints: ["src/main.jsx"], bundle: true, minify: true, write: false, format: "iife", jsx: "automatic" });
const js = r.outputFiles[0].text.replace(/<\/script/g, "<\\/script");
fs.writeFileSync("dist/index.html", `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cash-Future Arbitrage · Net ROCE Scanner</title></head><body style="margin:0"><div id="root"></div><script>${js}</script></body></html>`);
const calc = fs.readFileSync("src/calc.js", "utf8").replace(/^export /gm, "");
const comp = fs.readFileSync("src/ArbDashboard.jsx", "utf8").replace(/import \{[\s\S]*?\} from "\.\/calc\.js";\n/, "")
  .replace(/^export function/gm, "function");
const [imp, ...rest] = comp.split("\n");
fs.writeFileSync("dist/ArbDashboard.artifact.jsx", [imp, "", calc, rest.join("\n")].join("\n"));
console.log("built dist/index.html and dist/ArbDashboard.artifact.jsx");
