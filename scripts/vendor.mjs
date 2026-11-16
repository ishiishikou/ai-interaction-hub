import {cpSync,copyFileSync,mkdirSync} from "node:fs";
import {resolve,join} from "node:path";
import {fileURLToPath} from "node:url";
const root=resolve(fileURLToPath(new URL("..",import.meta.url)));
const from=(part)=>join(root,"node_modules",part);
const target=join(root,"static","vendor");
mkdirSync(target,{recursive:true});
const file=(source,name)=>copyFileSync(from(source),join(target,name));
file("markdown-it/dist/markdown-it.min.js","markdown-it.min.js");
file("@highlightjs/cdn-assets/highlight.min.js","highlight.min.js");
file("@highlightjs/cdn-assets/styles/github.min.css","highlight.css");
file("katex/dist/katex.min.js","katex.min.js");
file("katex/dist/katex.min.css","katex.min.css");
file("markdown-it-texmath/texmath.js","texmath.min.js");
file("markdown-it-texmath/css/texmath.css","texmath.css");
cpSync(from("katex/dist/fonts"),join(target,"fonts"),{recursive:true});
mkdirSync(join(target,"licenses"),{recursive:true});
for (const [src,name] of [
  ["markdown-it/LICENSE","markdown-it.txt"],
  ["@highlightjs/cdn-assets/LICENSE","highlightjs.txt"],
  ["katex/LICENSE","katex.txt"],
  ["markdown-it-texmath/license.txt","texmath.txt"]
]) copyFileSync(from(src),join(target,"licenses",name));
console.log("Vendored browser libraries to static/vendor");
