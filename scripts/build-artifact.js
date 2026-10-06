// Bundles index.html, styles.css and the scripts into one self-contained page
// for publishing as a Claude artifact (dist/house-maintenance.html).
//
// The artifact host wraps the page in its own <html>/<head>/<body>, so the
// output is the page content only: <title>, <style>, the body markup, and
// the scripts inlined in their original order.
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const html = read("index.html");
const title = html.match(/<title>([\s\S]*?)<\/title>/)[1].trim();
let body = html.match(/<body>([\s\S]*)<\/body>/)[1];

const scriptTag = /\s*<script src="([^"]+)"><\/script>/g;
const scripts = [...body.matchAll(scriptTag)].map((m) => m[1]);
body = body.replace(scriptTag, "");

// "</script" inside a script would end the inline block early.
const inline = (code) => code.replace(/<\/script/gi, "<\\/script");

const out = [
  `<title>${title}</title>`,
  `<style>\n${read("styles.css").trim()}\n</style>`,
  body.trim(),
  ...scripts.map((src) => `<script>\n${inline(read(src)).trim()}\n</script>`),
  "",
].join("\n");

const dest = path.join(root, "dist", "house-maintenance.html");
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, out);
console.log(`Wrote ${path.relative(root, dest)} (${(out.length / 1024).toFixed(1)} KB, scripts: ${scripts.join(", ")})`);
