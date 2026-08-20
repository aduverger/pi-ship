import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
const expected = {
  name: "@aduverger/pi-ship",
  repository: "git+https://github.com/aduverger/pi-ship.git",
  homepage: "https://github.com/aduverger/pi-ship#readme",
  bugs: "https://github.com/aduverger/pi-ship/issues",
  author: "Alexandre Duverger",
};
for (const [field, value] of Object.entries(expected)) {
  let actual = pkg[field];
  if (field === "repository") actual = pkg.repository?.url;
  if (field === "bugs") actual = pkg.bugs?.url;
  if (actual !== value) throw new Error(`package ${field} must be ${value}`);
}
if (pkg.publishConfig?.access !== "public") throw new Error("package must publish with public access");
if (!pkg.pi?.extensions?.includes("./dist/index.js")) throw new Error("Pi extension manifest missing");
if (JSON.stringify(pkg.exports) !== JSON.stringify({ ".": "./dist/index.js" })) {
  throw new Error("package must expose only the Pi extension entry point");
}
if (pkg.main !== "./dist/index.js" || pkg.types !== "./dist/index.d.ts") {
  throw new Error("package entry points must use the compiled extension");
}
for (const name of [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
]) {
  if (pkg.dependencies?.[name]) throw new Error(`${name} must remain a peer dependency`);
  if (pkg.peerDependencies?.[name] !== "*") throw new Error(`${name} must use Pi's bundled runtime`);
}

const packEnvironment = {
  ...process.env,
  npm_config_cache: new URL("../.npm-cache", import.meta.url).pathname,
};
const packResult = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    encoding: "utf8",
    env: packEnvironment,
  }),
)[0];
const packed = new Set(packResult.files.map((file) => file.path));
const modules = [
  "git",
  "index",
  "related-prs",
  "review-display",
  "reviewer-child",
  "reviewer",
  "simplify",
  "types",
  "workflow",
];
const allowed = new Set([
  "LICENSE",
  "NOTICE.md",
  "README.md",
  "package.json",
  "scripts/verify-package.mjs",
  ...modules.flatMap((module) => [
    `dist/${module}.d.ts`,
    `dist/${module}.d.ts.map`,
    `dist/${module}.js`,
    `dist/${module}.js.map`,
  ]),
]);
for (const file of packed) {
  if (!allowed.has(file)) throw new Error(`package contains unapproved file: ${file}`);
}
for (const file of allowed) {
  if (!packed.has(file)) throw new Error(`package omits required file: ${file}`);
}
for (const file of packed) {
  if (/(^|\/)src\/|\.test\.|package-lock\.json|(^|\/)docs\//.test(file)) {
    throw new Error(`package contains forbidden development file: ${file}`);
  }
}
console.log("package verification passed");
