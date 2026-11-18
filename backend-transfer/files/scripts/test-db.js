/**
 * `npm run test:db` — runs ONLY the in-memory MongoDB suites (tests/*.db.test.js)
 * and FAILS (instead of skipping) when mongodb-memory-server is unavailable.
 *
 * Never touches a real database: see tests/helpers/memoryDb.js.
 * Files run one at a time: each DB suite starts its own mongod, and suites
 * share uploads/ (temp-file cleanup assertions would see each other).
 * Uses the devDependency mongodb-memory-server-core. The first run downloads
 * a ~590 MB mongod 7.0.14 archive (~160 MB unpacked) into
 * ~/.cache/mongodb-binaries (override with MONGOMS_DOWNLOAD_DIR); CI should
 * cache that directory. No download ever happens during `npm install`.
 */
const { spawnSync } = require("node:child_process");

const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "tests/*.db.test.js"], {
  stdio: "inherit",
  env: { ...process.env, REQUIRE_DB_TESTS: "1" },
});

process.exit(result.status ?? 1);
