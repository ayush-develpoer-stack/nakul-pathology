/**
 * Shared harness for the *.db.test.js suites: an ISOLATED, throwaway MongoDB
 * (mongodb-memory-server on 127.0.0.1) + the real Express app on a random
 * loopback port. Requires ./setup first, so every credential is blanked and
 * MONGODB_URI points at an unreachable 127.0.0.1:1 — the developer's .env can
 * never reach a real database.
 *
 * Reproducibility: the MongoDB server version is pinned (MONGOMS_VERSION,
 * default 7.0.14) and the binary is cached by mongodb-memory-server after the
 * first download.
 *
 * Uses the devDependency mongodb-memory-server-core (pinned). Unlike the
 * "mongodb-memory-server" wrapper it has NO postinstall download, so
 * `npm install` on Render/Vercel never fetches a mongod binary. The binary
 * (~590 MB download, ~160 MB unpacked, mongod 7.0.14) is fetched on the
 * first DB test run into ~/.cache/mongodb-binaries (or MONGOMS_DOWNLOAD_DIR)
 * and reused afterwards. MONGODB_MEMORY_SERVER_MODULE can point elsewhere.
 *
 * When the module or the binary is unavailable:
 *   - REQUIRE_DB_TESTS=1 (set by `npm run test:db`) → the suite FAILS.
 *   - otherwise → exactly one test per DB suite is reported as SKIPPED,
 *     with the reason, in the test summary (never silently omitted).
 */
process.env.RATE_LIMIT_MAX_REQUESTS = process.env.RATE_LIMIT_MAX_REQUESTS || "100000";
process.env.PUBLIC_RATE_LIMIT_MAX_REQUESTS = process.env.PUBLIC_RATE_LIMIT_MAX_REQUESTS || "100000";
process.env.MONGOMS_VERSION = process.env.MONGOMS_VERSION || "7.0.14";
const { env } = require("./setup");

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

let MongoMemoryServer = null;
let unavailableReason = "";
try {
  ({ MongoMemoryServer } = require(process.env.MONGODB_MEMORY_SERVER_MODULE || "mongodb-memory-server-core"));
} catch {
  unavailableReason =
    "mongodb-memory-server-core is not installed — run `npm install` (it is a devDependency) " +
    "or set MONGODB_MEMORY_SERVER_MODULE";
}

// Generous: on a loaded machine mongod can take >10 s (the library default) to start.
const LAUNCH_OPTIONS = { instance: { launchTimeout: 60000 } };

/**
 * describe() that runs `fn` only when an in-memory MongoDB is available;
 * otherwise registers one visible skipped (or, with REQUIRE_DB_TESTS=1,
 * failing) test carrying the reason.
 */
function dbSuite(name, fn) {
  if (MongoMemoryServer) return describe(name, fn);
  return describe(name, () => {
    if (process.env.REQUIRE_DB_TESTS === "1") {
      test("in-memory MongoDB is available", () => assert.fail(unavailableReason));
    } else {
      test("in-memory MongoDB suite", { skip: unavailableReason }, () => {});
    }
  });
}

/** Starts mongod + connects mongoose + listens. Returns helpers and stop(). */
async function startDbApp() {
  const mongod = await MongoMemoryServer.create(LAUNCH_OPTIONS);
  const uri = mongod.getUri();
  const host = new URL(uri).hostname;
  assert.ok(host === "127.0.0.1" || host === "localhost", "refusing to connect to a non-loopback database");
  assert.notEqual(uri, env.MONGODB_URI);

  const mongoose = require("mongoose");
  await mongoose.connect(uri, { dbName: "nakul_crm_test" });

  const app = require("../../src/app");
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function api(method, path, { token, body, headers = {}, form } = {}) {
    const init = { method, headers: { ...headers } };
    if (token) init.headers.Authorization = `Bearer ${token}`;
    if (form) init.body = form;
    else if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    const res = await fetch(base + path, init);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* binary or empty */
    }
    return { status: res.status, body: json, headers: res.headers, text };
  }

  async function stop() {
    await new Promise((r) => server.close(r));
    await mongoose.disconnect();
    await mongod.stop();
  }

  return { mongoose, base, api, stop };
}

module.exports = { dbSuite, startDbApp, env, getMongoMemoryServer: () => MongoMemoryServer, LAUNCH_OPTIONS };
