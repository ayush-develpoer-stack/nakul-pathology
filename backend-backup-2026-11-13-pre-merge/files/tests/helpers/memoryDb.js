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
 * mongodb-memory-server is deliberately NOT a package.json dependency (the
 * package itself is small, but its first run downloads a ~590 MB mongod
 * binary). Resolution order:
 *   1. MONGODB_MEMORY_SERVER_MODULE=/abs/path/to/node_modules/mongodb-memory-server
 *   2. a local install: npm i --no-save mongodb-memory-server@10.1.4
 *
 * When it can't be resolved:
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
  ({ MongoMemoryServer } = require(process.env.MONGODB_MEMORY_SERVER_MODULE || "mongodb-memory-server"));
} catch {
  unavailableReason =
    "mongodb-memory-server is not installed — run `npm i --no-save mongodb-memory-server@10.1.4` " +
    "or set MONGODB_MEMORY_SERVER_MODULE";
}

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
  const mongod = await MongoMemoryServer.create();
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

module.exports = { dbSuite, startDbApp, env, getMongoMemoryServer: () => MongoMemoryServer };
