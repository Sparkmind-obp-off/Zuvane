// Syntax-checks every JavaScript source file (no bundler required).
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const roots = ["worker", "src", "public", "test", "scripts"];
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(m?js)$/.test(name)) files.push(path);
  }
};
roots.forEach(walk);
for (const file of files) execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
console.log(`syntax ok: ${files.length} files`);
