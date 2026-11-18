#!/usr/bin/env node
/**
 * Copies the verified backend-staging import/export work into the real backend.
 *
 * RUN ONLY AFTER the backend dev server (nodemon) has been stopped — copying
 * into src/ restarts it against the production .env.
 *
 *   node apply-staging.js "C:\Users\Hp 440 G7\OneDrive\Desktop\nakul-pathology-crm\backend"          # dry run
 *   node apply-staging.js "C:\Users\Hp 440 G7\OneDrive\Desktop\nakul-pathology-crm\backend" --apply  # copy
 *
 * Safety: every target file must still have the hash it had when the staging
 * diff was made (or still be absent). If the user changed any of them since,
 * NOTHING is copied and the changed files are listed — merge those by hand
 * from staging-import.patch. Never touches .env, uploads/ or node_modules/.
 *
 * Afterwards (in backend/):  npm ci   then   npm test   and   npm run test:db
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const [target, flag] = process.argv.slice(2);
if (!target || !fs.existsSync(path.join(target, "package.json"))) {
  console.error("Usage: node apply-staging.js <backend dir> [--apply]");
  process.exit(2);
}
const here = __dirname;
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const rows = fs
  .readFileSync(path.join(here, "manifest.tsv"), "utf8")
  .trim()
  .split(/\r?\n/)
  .map((l) => l.split("\t"));

const conflicts = [];
for (const [rel, expectedOld, expectedNew] of rows) {
  if (/(^|\/)(\.env|uploads|node_modules)(\/|$)/.test(rel)) throw new Error(`refusing to touch ${rel}`);
  const src = path.join(here, "files", rel);
  if (sha(src) !== expectedNew) throw new Error(`transfer copy of ${rel} is corrupt`);
  const dst = path.join(target, rel);
  const now = fs.existsSync(dst) ? sha(dst) : "ABSENT";
  if (now === expectedNew) continue; // already applied
  if (now !== expectedOld) conflicts.push(rel);
}
if (conflicts.length) {
  console.error("ABORTED — these files changed since the staging diff was made (nothing copied):");
  conflicts.forEach((c) => console.error("  " + c));
  process.exit(1);
}
for (const [rel, , expectedNew] of rows) {
  const dst = path.join(target, rel);
  const done = fs.existsSync(dst) && sha(dst) === expectedNew;
  console.log(`${done ? "unchanged" : flag === "--apply" ? "copy     " : "would copy"}  ${rel}`);
  if (!done && flag === "--apply") {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(here, "files", rel), dst);
  }
}
if (flag !== "--apply") console.log("\nDry run only. Re-run with --apply after stopping the backend dev server.");
