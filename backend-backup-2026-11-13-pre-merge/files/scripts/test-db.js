/**
 * `npm run test:db` — runs ONLY the in-memory MongoDB suites (tests/*.db.test.js)
 * and FAILS (instead of skipping) when mongodb-memory-server is unavailable.
 *
 * Never touches a real database: see tests/helpers/memoryDb.js.
 * Prerequisite (not a package.json dependency; first run downloads a
 * ~590 MB mongod 7.0.14 binary into the mongodb-memory-server cache):
 *   npm i --no-save mongodb-memory-server@10.1.4
 * or set MONGODB_MEMORY_SERVER_MODULE to an existing install.
 */
const { spawnSync } = require("node:child_process");

const result = spawnSync(process.execPath, ["--test", "tests/*.db.test.js"], {
  stdio: "inherit",
  env: { ...process.env, REQUIRE_DB_TESTS: "1" },
});

process.exit(result.status ?? 1);
