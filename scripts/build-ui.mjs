import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const template = readFileSync("plugin/ui.template.html", "utf8");
const css = readFileSync("plugin/ui.css", "utf8");
const output = template.replace("<!-- INLINE_CSS -->", `<style>${css}</style>`);

mkdirSync("plugin/dist", { recursive: true });
writeFileSync("plugin/dist/ui.html", output, "utf8");
console.log("Wrote plugin/dist/ui.html");
