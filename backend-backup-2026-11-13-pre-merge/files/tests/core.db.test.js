/**
 * Core CRM API integration tests against an ISOLATED, throwaway MongoDB
 * (mongodb-memory-server bound to 127.0.0.1, deleted when the run ends).
 *
 * Covers: auth/JWT/logout, user management + role rules, customers, leads,
 * follow-ups, tests, packages, appointments (CRM + public), reports,
 * prescriptions, public contact, dashboard stats, activities, audit logs,
 * validation, NoSQL-injection guards and security middleware.
 *
 * Safety:
 *  - tests/helpers/setup.js is loaded first: it blanks every credential and
 *    points MONGODB_URI at an unreachable 127.0.0.1:1, so the developer's
 *    .env can never be used. This file connects mongoose ONLY to the
 *    in-memory server, and asserts that URI is loopback before connecting.
 *  - Cloudinary is never called: uploadFile/generateSignedDownloadUrl are
 *    replaced by fakes. No WhatsApp provider is touched.
 *
 * mongodb-memory-server availability / skip policy: see helpers/memoryDb.js.
 */
// Isolation, version pinning and the skip/fail policy live in helpers/memoryDb.js.
const { dbSuite, env, getMongoMemoryServer } = require("./helpers/memoryDb");

const { describe, test, before, after, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const jwt = require("jsonwebtoken");

dbSuite("Core CRM API (isolated in-memory MongoDB)", () => {
  let mongod;
  let mongoose;
  let server;
  let base;
  let models;
  let cloudinaryService;
  const tokens = {};
  const ids = {};

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
  const admin = (m, p, o = {}) => api(m, p, { ...o, token: tokens.admin });
  const staff = (m, p, o = {}) => api(m, p, { ...o, token: tokens.staff });

  function fileForm(fields, { name = "report.pdf", type = "application/pdf" } = {}) {
    const form = new FormData();
    Object.entries(fields).forEach(([k, v]) => form.append(k, v));
    form.append("file", new Blob([Buffer.from("%PDF-1.4 fake")], { type }), name);
    return form;
  }

  before(async () => {
    mongod = await getMongoMemoryServer().create();
    const uri = mongod.getUri();
    const host = new URL(uri).hostname;
    assert.ok(host === "127.0.0.1" || host === "localhost", "refusing to connect to a non-loopback database");
    assert.notEqual(uri, env.MONGODB_URI);

    mongoose = require("mongoose");
    await mongoose.connect(uri, { dbName: "nakul_crm_test" });

    cloudinaryService = require("../src/services/cloudinary.service");
    mock.method(cloudinaryService, "uploadFile", async (localPath, folder) => {
      fs.unlink(localPath, () => {});
      return {
        url: "https://res.example.test/private/file.pdf",
        publicId: `${folder}/fake-${Date.now()}`,
        resourceType: "image",
        deliveryType: "authenticated",
        format: "pdf",
      };
    });
    mock.method(cloudinaryService, "generateSignedDownloadUrl", ({ publicId }) =>
      publicId ? `https://signed.example.test/${encodeURIComponent(publicId)}?exp=1` : "",
    );

    models = {
      User: require("../src/models/User"),
      Customer: require("../src/models/Customer"),
      Lead: require("../src/models/Lead"),
      FollowUp: require("../src/models/FollowUp"),
      Appointment: require("../src/models/Appointment"),
      Report: require("../src/models/Report"),
      AuditLog: require("../src/models/AuditLog"),
      Activity: require("../src/models/Activity"),
    };
    await Promise.all(Object.values(models).map((m) => m.init()));

    const app = require("../src/app");
    server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${server.address().port}`;

    await models.User.create({ name: "Admin One", email: "admin@test.local", password: "AdminPass123", role: "admin" });
    await models.User.create({ name: "Staff One", email: "staff@test.local", password: "StaffPass123", role: "staff" });
    await models.User.create({ name: "Gone Staff", email: "inactive@test.local", password: "InactivePass1", role: "staff", isActive: false });
  });

  after(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (mongoose) await mongoose.disconnect();
    if (mongod) await mongod.stop();
    mock.restoreAll();
  });

  // ==================================================================
  // AUTH
  // ==================================================================
  describe("Auth: login / me / logout / JWT", () => {
    test("login succeeds (case-insensitive email), returns token + httpOnly cookie, never the password", async () => {
      const res = await api("POST", "/api/v1/auth/login", { body: { email: "ADMIN@test.local", password: "AdminPass123" } });
      assert.equal(res.status, 200);
      assert.ok(res.body.data.token);
      assert.equal(res.body.data.user.email, "admin@test.local");
      assert.equal(res.body.data.user.password, undefined);
      const cookie = res.headers.get("set-cookie") || "";
      assert.match(cookie, /token=/);
      assert.match(cookie, /HttpOnly/i);
      tokens.admin = res.body.data.token;
      const u = await models.User.findOne({ email: "admin@test.local" });
      assert.ok(u.lastLogin instanceof Date);

      const s = await api("POST", "/api/v1/auth/login", { body: { email: "staff@test.local", password: "StaffPass123" } });
      assert.equal(s.status, 200);
      tokens.staff = s.body.data.token;
    });

    test("wrong password and unknown email give the same 401 (no user enumeration)", async () => {
      const a = await api("POST", "/api/v1/auth/login", { body: { email: "admin@test.local", password: "nope-nope" } });
      const b = await api("POST", "/api/v1/auth/login", { body: { email: "ghost@test.local", password: "nope-nope" } });
      assert.equal(a.status, 401);
      assert.equal(b.status, 401);
      assert.equal(a.body.message, b.body.message);
    });

    test("login validation and NoSQL-injection payloads are rejected with 400", async () => {
      const bad = await api("POST", "/api/v1/auth/login", { body: { email: "not-an-email", password: "" } });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.success, false);
      assert.ok(bad.body.errors.length >= 1);
      const inj = await api("POST", "/api/v1/auth/login", { body: { email: { $gt: "" }, password: { $gt: "" } } });
      assert.equal(inj.status, 400);
    });

    test("deactivated user cannot log in (403)", async () => {
      const res = await api("POST", "/api/v1/auth/login", { body: { email: "inactive@test.local", password: "InactivePass1" } });
      assert.equal(res.status, 403);
    });

    test("/me: 401 without token, with garbage, with wrong-secret and expired tokens; 200 via Bearer and via cookie", async () => {
      assert.equal((await api("GET", "/api/v1/auth/me")).status, 401);
      assert.equal((await api("GET", "/api/v1/auth/me", { token: "garbage" })).status, 401);
      const u = await models.User.findOne({ email: "admin@test.local" });
      const forged = jwt.sign({ id: String(u._id), role: "admin" }, "some-other-secret");
      assert.equal((await api("GET", "/api/v1/auth/me", { token: forged })).status, 401);
      const expired = jwt.sign({ id: String(u._id), role: "admin" }, env.JWT_SECRET, { expiresIn: -10 });
      assert.equal((await api("GET", "/api/v1/auth/me", { token: expired })).status, 401);

      const viaBearer = await admin("GET", "/api/v1/auth/me");
      assert.equal(viaBearer.status, 200);
      assert.equal(viaBearer.body.data.user.email, "admin@test.local");
      assert.equal(viaBearer.body.data.user.password, undefined);
      const viaCookie = await api("GET", "/api/v1/auth/me", { headers: { Cookie: `token=${tokens.admin}` } });
      assert.equal(viaCookie.status, 200);
    });

    test("a token whose user was deleted gets 401; a deactivated user's live token gets 403", async () => {
      const tmp = await models.User.create({ name: "Temp", email: "temp@test.local", password: "TempPass123" });
      const t = jwt.sign({ id: String(tmp._id), role: "staff" }, env.JWT_SECRET);
      await models.User.updateOne({ _id: tmp._id }, { isActive: false });
      assert.equal((await api("GET", "/api/v1/auth/me", { token: t })).status, 403);
      await models.User.deleteOne({ _id: tmp._id });
      assert.equal((await api("GET", "/api/v1/auth/me", { token: t })).status, 401);
    });

    test("the role claim inside the JWT is not trusted (role comes from the DB)", async () => {
      const s = await models.User.findOne({ email: "staff@test.local" });
      const escalated = jwt.sign({ id: String(s._id), role: "admin" }, env.JWT_SECRET);
      assert.equal((await api("GET", "/api/v1/auth/users", { token: escalated })).status, 403);
    });

    test("logout requires auth and clears the cookie", async () => {
      assert.equal((await api("POST", "/api/v1/auth/logout")).status, 401);
      const res = await staff("POST", "/api/v1/auth/logout");
      assert.equal(res.status, 200);
      assert.match(res.headers.get("set-cookie") || "", /token=;/);
    });
  });

  // ==================================================================
  // USERS & ROLES
  // ==================================================================
  describe("User management & roles", () => {
    test("staff is forbidden from every user-management endpoint", async () => {
      const me = await models.User.findOne({ email: "staff@test.local" });
      assert.equal((await staff("GET", "/api/v1/auth/users")).status, 403);
      assert.equal((await staff("POST", "/api/v1/auth/users", { body: { name: "X Y", email: "x@test.local", password: "Password1" } })).status, 403);
      assert.equal((await staff("PATCH", `/api/v1/auth/users/${me._id}`, { body: { role: "admin" } })).status, 403);
      assert.equal((await staff("PATCH", `/api/v1/auth/users/${me._id}/status`, { body: { isActive: false } })).status, 403);
    });

    test("admin creates a user (defaults to staff, password hashed and hidden), duplicate email 409, validation 400", async () => {
      const res = await admin("POST", "/api/v1/auth/users", { body: { name: "New Staff", email: "New@Test.local", password: "Password123" } });
      assert.equal(res.status, 201);
      assert.equal(res.body.data.role, "staff");
      assert.equal(res.body.data.email, "new@test.local");
      assert.equal(res.body.data.password, undefined);
      ids.newUser = res.body.data._id;
      const stored = await models.User.findById(ids.newUser).select("+password");
      assert.notEqual(stored.password, "Password123");

      assert.equal((await admin("POST", "/api/v1/auth/users", { body: { name: "Dup", email: "new@test.local", password: "Password123" } })).status, 409);
      assert.equal((await admin("POST", "/api/v1/auth/users", { body: { name: "Short", email: "s@test.local", password: "short" } })).status, 400);
      assert.equal((await admin("POST", "/api/v1/auth/users", { body: { name: "Root", email: "r@test.local", password: "Password123", role: "superuser" } })).status, 400);

      const login = await api("POST", "/api/v1/auth/login", { body: { email: "new@test.local", password: "Password123" } });
      assert.equal(login.status, 200);
    });

    test("list users: pagination meta, role filter, search (including phone-style '+91' input)", async () => {
      const res = await admin("GET", "/api/v1/auth/users?limit=2&page=1");
      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, 2);
      assert.equal(res.body.pagination.limit, 2);
      assert.ok(res.body.pagination.total >= 4);
      res.body.data.forEach((u) => assert.equal(u.password, undefined));

      const admins = await admin("GET", "/api/v1/auth/users?role=admin");
      assert.ok(admins.body.data.every((u) => u.role === "admin"));

      const search = await admin("GET", "/api/v1/auth/users?search=new%20staff");
      assert.equal(search.body.data.length, 1);

      const plus = await admin("GET", `/api/v1/auth/users?search=${encodeURIComponent("+91")}`);
      assert.equal(plus.status, 200, "a phone-number search must not crash the endpoint");
    });

    test("update user: whitelisted fields only (email/password/isActive are ignored)", async () => {
      const res = await admin("PATCH", `/api/v1/auth/users/${ids.newUser}`, {
        body: { name: "Renamed Staff", email: "hacked@test.local", password: "x", isActive: false },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.name, "Renamed Staff");
      assert.equal(res.body.data.email, "new@test.local");
      assert.equal(res.body.data.isActive, true);
      assert.equal((await admin("PATCH", `/api/v1/auth/users/${ids.newUser}`, { body: {} })).status, 400);
      assert.equal((await admin("PATCH", "/api/v1/auth/users/65c000000000000000000fff", { body: { name: "Nobody" } })).status, 404);
      assert.equal((await admin("PATCH", "/api/v1/auth/users/not-an-id", { body: { name: "Nobody" } })).status, 400);
    });

    test("admin cannot demote or deactivate themselves; the last active admin is protected", async () => {
      const me = await models.User.findOne({ email: "admin@test.local" });
      assert.equal((await admin("PATCH", `/api/v1/auth/users/${me._id}`, { body: { role: "staff" } })).status, 400);
      assert.equal((await admin("PATCH", `/api/v1/auth/users/${me._id}/status`, { body: { isActive: false } })).status, 400);

      const second = await admin("POST", "/api/v1/auth/users", { body: { name: "Admin Two", email: "admin2@test.local", password: "Password123", role: "admin" } });
      assert.equal(second.status, 201);
      // Two admins → demoting one is allowed.
      assert.equal((await admin("PATCH", `/api/v1/auth/users/${second.body.data._id}`, { body: { role: "staff" } })).status, 200);
      // Back to one admin; that admin may not be demoted/deactivated by a peer path either.
      const count = await models.User.countDocuments({ role: "admin", isActive: true });
      assert.equal(count, 1);
    });

    test("activate/deactivate another user; a deactivated user's token stops working", async () => {
      const login = await api("POST", "/api/v1/auth/login", { body: { email: "new@test.local", password: "Password123" } });
      const t = login.body.data.token;
      assert.equal((await admin("PATCH", `/api/v1/auth/users/${ids.newUser}/status`, { body: { isActive: false } })).status, 200);
      assert.equal((await api("GET", "/api/v1/auth/me", { token: t })).status, 403);
      assert.equal((await admin("PATCH", `/api/v1/auth/users/${ids.newUser}/status`, { body: { isActive: "no" } })).status, 400);
      assert.equal((await admin("PATCH", `/api/v1/auth/users/${ids.newUser}/status`, { body: { isActive: true } })).status, 200);
    });
  });

  // ==================================================================
  // CUSTOMERS
  // ==================================================================
  describe("Customers", () => {
    test("requires authentication", async () => {
      assert.equal((await api("GET", "/api/v1/customers")).status, 401);
      assert.equal((await api("POST", "/api/v1/customers", { body: { name: "A", mobile: "1" } })).status, 401);
    });

    test("create normalizes the phone, generates customerId, writes an audit log", async () => {
      const res = await staff("POST", "/api/v1/customers", {
        body: { name: "Ravi Kumar", mobile: "+91 98765-43210", whatsappNumber: "919876543210", city: "Agra", tags: ["vip"], marketingOptIn: true },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.data.mobile, "9876543210");
      assert.equal(res.body.data.whatsappNumber, "9876543210");
      assert.match(res.body.data.customerId, /^CUS-/);
      ids.customer = res.body.data._id;
      const audit = await models.AuditLog.findOne({ entity: "Customer", action: "create", entityId: res.body.data.customerId });
      assert.ok(audit, "audit log written");
      assert.ok(audit.user, "audit log records the acting user");
    });

    test("duplicate mobile in a different format → 409; missing/invalid fields → 400 with field errors", async () => {
      const dup = await staff("POST", "/api/v1/customers", { body: { name: "Ravi Again", mobile: "09876543210".replace(/^0/, "") } });
      assert.equal(dup.status, 409);
      const bad = await staff("POST", "/api/v1/customers", { body: { mobile: "12" } });
      assert.equal(bad.status, 400);
      const fields = bad.body.errors.map((e) => e.field);
      assert.ok(fields.includes("name"));
      assert.ok(fields.includes("mobile"));
      const gender = await staff("POST", "/api/v1/customers", { body: { name: "G", mobile: "9000000001", gender: "robot" } });
      assert.equal(gender.status, 400);
    });

    test("list: pagination meta, search, status/tag/city filters, special-character search is safe", async () => {
      for (let i = 0; i < 5; i += 1) {
        const r = await staff("POST", "/api/v1/customers", { body: { name: `Bulk Person ${i}`, mobile: `900000010${i}`, city: i % 2 ? "Delhi" : "Agra" } });
        assert.equal(r.status, 201);
      }
      const page = await staff("GET", "/api/v1/customers?limit=2&page=2");
      assert.equal(page.status, 200);
      assert.equal(page.body.data.length, 2);
      assert.deepEqual({ ...page.body.pagination }, { page: 2, limit: 2, total: 6, totalPages: 3 });

      const capped = await staff("GET", "/api/v1/customers?limit=100000");
      assert.equal(capped.body.pagination.limit, 100);

      const search = await staff("GET", "/api/v1/customers?search=ravi");
      assert.equal(search.body.data.length, 1);
      const byMobile = await staff("GET", "/api/v1/customers?search=98765");
      assert.equal(byMobile.body.data.length, 1);
      const city = await staff("GET", "/api/v1/customers?city=delhi");
      assert.equal(city.body.data.length, 2);
      const tag = await staff("GET", "/api/v1/customers?tags=vip");
      assert.equal(tag.body.data.length, 1);
      // Dashboard "Marketing Opt-in" card = total of ?marketingOptIn=true
      const optIn = await staff("GET", "/api/v1/customers?marketingOptIn=true&limit=1");
      assert.equal(optIn.body.pagination.total, 1);
      assert.equal((await staff("GET", "/api/v1/customers?marketingOptIn=false&limit=1")).body.pagination.total, 5);
      assert.equal((await staff("GET", "/api/v1/customers?marketingOptIn=all&limit=1")).body.pagination.total, 6);
      assert.equal((await staff("GET", "/api/v1/customers?marketingOptIn=maybe")).status, 400);
      const special = await staff("GET", `/api/v1/customers?search=${encodeURIComponent("+91(")}`);
      assert.equal(special.status, 200);
      assert.equal((await staff("GET", "/api/v1/customers?status=deleted")).status, 400);
      const asc = await staff("GET", "/api/v1/customers?sortBy=name&sortOrder=asc&limit=100");
      const names = asc.body.data.map((c) => c.name);
      assert.deepEqual(names, [...names].sort());
    });

    test("query-string operator injection is rejected", async () => {
      const res = await staff("GET", "/api/v1/customers?search[$ne]=x");
      assert.equal(res.status, 400);
    });

    test("get by id: 200 / 404 unknown / 400 malformed", async () => {
      assert.equal((await staff("GET", `/api/v1/customers/${ids.customer}`)).status, 200);
      assert.equal((await staff("GET", "/api/v1/customers/65c000000000000000000fff")).status, 404);
      assert.equal((await staff("GET", "/api/v1/customers/not-an-id")).status, 400);
    });

    test("PATCH with one field does not reset other fields to schema defaults", async () => {
      const res = await staff("PATCH", `/api/v1/customers/${ids.customer}`, { body: { city: "Mathura" } });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.city, "Mathura");
      assert.deepEqual(res.body.data.tags, ["vip"]);
      assert.equal(res.body.data.marketingOptIn, true);
      assert.equal(res.body.data.name, "Ravi Kumar");
    });

    test("PATCH to another customer's mobile → 409; own unchanged mobile is fine", async () => {
      assert.equal((await staff("PATCH", `/api/v1/customers/${ids.customer}`, { body: { mobile: "9000000100" } })).status, 409);
      assert.equal((await staff("PATCH", `/api/v1/customers/${ids.customer}`, { body: { mobile: "+91 9876543210" } })).status, 200);
      assert.equal((await staff("PATCH", "/api/v1/customers/65c000000000000000000fff", { body: { city: "X" } })).status, 404);
    });

    test("status, tags (deduplicated), notes, activity", async () => {
      const st = await staff("PATCH", `/api/v1/customers/${ids.customer}/status`, { body: { status: "inactive" } });
      assert.equal(st.body.data.status, "inactive");
      assert.equal((await staff("PATCH", `/api/v1/customers/${ids.customer}/status`, { body: { status: "gone" } })).status, 400);
      await staff("POST", `/api/v1/customers/${ids.customer}/tags`, { body: { tag: "diabetic" } });
      const t2 = await staff("POST", `/api/v1/customers/${ids.customer}/tags`, { body: { tag: "diabetic" } });
      assert.deepEqual(t2.body.data.tags, ["vip", "diabetic"]);
      const rm = await staff("DELETE", `/api/v1/customers/${ids.customer}/tags/vip`);
      assert.deepEqual(rm.body.data.tags, ["diabetic"]);
      assert.equal((await staff("POST", `/api/v1/customers/${ids.customer}/tags`, { body: { tag: "  " } })).status, 400);
      const note = await staff("POST", `/api/v1/customers/${ids.customer}/notes`, { body: { text: "Prefers morning calls" } });
      assert.equal(note.body.data.notes.length, 1);
      assert.ok(note.body.data.notes[0].addedBy);
      const act = await staff("GET", `/api/v1/customers/${ids.customer}/activity`);
      assert.equal(act.status, 200);
      assert.ok(Array.isArray(act.body.data));
    });

    test("export returns an xlsx attachment", async () => {
      const res = await fetch(`${base}/api/v1/customers/export`, { headers: { Authorization: `Bearer ${tokens.staff}` } });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type"), /spreadsheetml/);
      assert.match(res.headers.get("content-disposition"), /customers-export\.xlsx/);
      const buf = Buffer.from(await res.arrayBuffer());
      assert.equal(buf.subarray(0, 2).toString(), "PK");
    });

    test("import rejects a missing file and a disallowed file type", async () => {
      assert.equal((await staff("POST", "/api/v1/customers/import", { form: new FormData() })).status, 400);
      const exe = fileForm({}, { name: "evil.exe", type: "application/octet-stream" });
      assert.equal((await staff("POST", "/api/v1/customers/import", { form: exe })).status, 400);
    });

    test("delete is admin-only and audited", async () => {
      const victim = await staff("POST", "/api/v1/customers", { body: { name: "Delete Me", mobile: "9111111111" } });
      assert.equal((await staff("DELETE", `/api/v1/customers/${victim.body.data._id}`)).status, 403);
      assert.equal((await admin("DELETE", `/api/v1/customers/${victim.body.data._id}`)).status, 200);
      assert.equal((await admin("DELETE", `/api/v1/customers/${victim.body.data._id}`)).status, 404);
      assert.ok(await models.AuditLog.findOne({ entity: "Customer", action: "delete" }));
    });
  });

  // ==================================================================
  // LEADS & FOLLOW-UPS
  // ==================================================================
  describe("Leads", () => {
    test("create with nextFollowUpDate auto-creates a pending follow-up", async () => {
      const when = new Date(Date.now() + 3 * 86400000).toISOString();
      const res = await staff("POST", "/api/v1/leads", {
        body: { name: "Lead Alpha", mobile: "+91 99999 00001", email: "", source: "", status: "", nextFollowUpDate: when },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.data.mobile, "9999900001");
      assert.equal(res.body.data.source, "other");
      assert.equal(res.body.data.status, "new");
      assert.match(res.body.data.leadId, /^LEAD-/);
      ids.lead = res.body.data._id;
      const fus = await models.FollowUp.find({ lead: ids.lead });
      assert.equal(fus.length, 1);
      assert.equal(fus[0].status, "pending");
    });

    test("validation: bad email / status / short name → 400", async () => {
      assert.equal((await staff("POST", "/api/v1/leads", { body: { name: "L", mobile: "9999900002" } })).status, 400);
      assert.equal((await staff("POST", "/api/v1/leads", { body: { name: "Lead", mobile: "9999900002", email: "x@" } })).status, 400);
      assert.equal((await staff("POST", "/api/v1/leads", { body: { name: "Lead", mobile: "9999900002", status: "won" } })).status, 400);
    });

    test("list filters + search (phone-style and special characters must not 500)", async () => {
      await staff("POST", "/api/v1/leads", { body: { name: "Lead Beta", mobile: "9999900003", status: "contacted", source: "referral" } });
      const all = await staff("GET", "/api/v1/leads");
      assert.equal(all.status, 200);
      assert.equal(all.body.pagination.total, 2);
      assert.equal((await staff("GET", "/api/v1/leads?status=contacted")).body.data.length, 1);
      assert.equal((await staff("GET", "/api/v1/leads?source=referral")).body.data.length, 1);
      assert.equal((await staff("GET", "/api/v1/leads?search=alpha")).body.data.length, 1);
      const plus = await staff("GET", `/api/v1/leads?search=${encodeURIComponent("+9199999")}`);
      assert.equal(plus.status, 200, "searching a +91 number must not crash");
      const paren = await staff("GET", `/api/v1/leads?search=${encodeURIComponent("Lead (")}`);
      assert.equal(paren.status, 200, "an unbalanced parenthesis must not crash");
      const dot = await staff("GET", `/api/v1/leads?search=${encodeURIComponent("L.ad")}`);
      assert.equal(dot.body.data.length, 0, "search text is literal, not a regex");
    });

    test("update: changing nextFollowUpDate replaces pending follow-ups; clearing removes them", async () => {
      const when = new Date(Date.now() + 5 * 86400000).toISOString();
      const res = await staff("PATCH", `/api/v1/leads/${ids.lead}`, { body: { nextFollowUpDate: when, status: "interested" } });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.status, "interested");
      let pending = await models.FollowUp.find({ lead: ids.lead, status: "pending" });
      assert.equal(pending.length, 1);
      assert.equal(pending[0].date.toISOString(), when);
      const partial = await staff("PATCH", `/api/v1/leads/${ids.lead}`, { body: { notes: "called" } });
      assert.equal(partial.body.data.status, "interested", "partial update keeps status");
      assert.equal(partial.body.data.source, "other");
      pending = await models.FollowUp.find({ lead: ids.lead, status: "pending" });
      assert.equal(pending.length, 1, "unrelated update keeps follow-ups");
      await staff("PATCH", `/api/v1/leads/${ids.lead}`, { body: { nextFollowUpDate: "" } });
      pending = await models.FollowUp.find({ lead: ids.lead, status: "pending" });
      assert.equal(pending.length, 0);
      assert.equal((await staff("PATCH", "/api/v1/leads/65c000000000000000000fff", { body: { notes: "x" } })).status, 404);
    });

    test("delete is admin-only and removes the lead's follow-ups", async () => {
      const l = await staff("POST", "/api/v1/leads", { body: { name: "Lead Gone", mobile: "9999900009", nextFollowUpDate: new Date().toISOString() } });
      assert.equal((await staff("DELETE", `/api/v1/leads/${l.body.data._id}`)).status, 403);
      assert.equal((await admin("DELETE", `/api/v1/leads/${l.body.data._id}`)).status, 200);
      assert.equal(await models.FollowUp.countDocuments({ lead: l.body.data._id }), 0);
    });
  });

  describe("Follow-ups", () => {
    test("create for a lead sets lead.nextFollowUpDate; unknown lead 404; missing date 400", async () => {
      const staffUser = await models.User.findOne({ email: "staff@test.local" });
      const when = new Date();
      const res = await staff("POST", "/api/v1/follow-ups", {
        body: { leadId: ids.lead, type: "whatsapp", date: when.toISOString(), assignedTo: String(staffUser._id) },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.data.lead.name, "Lead Alpha");
      assert.equal(res.body.data.assignedTo.name, "Staff One");
      ids.followUp = res.body.data._id;
      const lead = await models.Lead.findById(ids.lead);
      assert.equal(lead.nextFollowUpDate.toISOString(), when.toISOString());
      assert.equal((await staff("POST", "/api/v1/follow-ups", { body: { leadId: "65c000000000000000000fff", date: when.toISOString() } })).status, 404);
      assert.equal((await staff("POST", "/api/v1/follow-ups", { body: { leadId: ids.lead } })).status, 400);
      assert.equal((await staff("POST", "/api/v1/follow-ups", { body: { leadId: ids.lead, date: when.toISOString(), type: "fax" } })).status, 400);
    });

    test("summary and tab lists (today / upcoming / overdue)", async () => {
      await models.FollowUp.create({ lead: ids.lead, type: "call", date: new Date(Date.now() - 3 * 86400000), status: "pending" });
      await models.FollowUp.create({ lead: ids.lead, type: "call", date: new Date(Date.now() + 3 * 86400000), status: "pending" });
      const sum = await staff("GET", "/api/v1/follow-ups/summary");
      assert.equal(sum.status, 200);
      assert.deepEqual(sum.body.data, { today: 1, upcoming: 1, overdue: 1, completed: 0 });
      const today = await staff("GET", "/api/v1/follow-ups?tab=today");
      assert.equal(today.body.data.length, 1);
      assert.equal(today.body.data[0].leadName, "Lead Alpha");
      assert.equal((await staff("GET", "/api/v1/follow-ups?tab=overdue")).body.data.length, 1);
      assert.equal((await staff("GET", "/api/v1/follow-ups?tab=upcoming")).body.data.length, 1);
    });

    test("PATCH that omits assignedTo keeps the existing assignee", async () => {
      const res = await staff("PATCH", `/api/v1/follow-ups/${ids.followUp}`, { body: { description: "Discuss package" } });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.description, "Discuss package");
      assert.ok(res.body.data.assignedTo, "assignee must not be wiped by an unrelated edit");
      assert.equal(res.body.data.assignedTo.name, "Staff One");
      // Explicit clearing still works.
      const cleared = await staff("PATCH", `/api/v1/follow-ups/${ids.followUp}`, { body: { assignedTo: "" } });
      assert.equal(cleared.body.data.assignedTo, null);
    });

    test("complete marks it done, records who, and recomputes lead.nextFollowUpDate", async () => {
      const res = await staff("PATCH", `/api/v1/follow-ups/${ids.followUp}/complete`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.status, "completed");
      assert.ok(res.body.data.completedAt);
      assert.ok(res.body.data.completedBy);
      const lead = await models.Lead.findById(ids.lead);
      const next = await models.FollowUp.findOne({ lead: ids.lead, status: "pending" }).sort({ date: 1 });
      assert.equal(lead.nextFollowUpDate.toISOString(), next.date.toISOString());
      assert.equal((await staff("GET", "/api/v1/follow-ups?tab=completed")).body.data.length, 1);
      assert.equal((await staff("PATCH", "/api/v1/follow-ups/65c000000000000000000fff/complete")).status, 404);
    });

    test("delete is admin-only", async () => {
      assert.equal((await staff("DELETE", `/api/v1/follow-ups/${ids.followUp}`)).status, 403);
      assert.equal((await admin("DELETE", `/api/v1/follow-ups/${ids.followUp}`)).status, 200);
      assert.equal((await admin("GET", `/api/v1/follow-ups/${ids.followUp}`)).status, 404);
    });
  });

  // ==================================================================
  // TESTS & PACKAGES
  // ==================================================================
  describe("Tests & packages (pricing)", () => {
    test("tests: admin-only writes, slug generation, duplicate slug 409, price validation", async () => {
      const body = { name: "Complete Blood Count (CBC)", price: 350, category: "Haematology" };
      assert.equal((await staff("POST", "/api/v1/tests", { body })).status, 403);
      const res = await admin("POST", "/api/v1/tests", { body });
      assert.equal(res.status, 201);
      assert.equal(res.body.data.slug, "complete-blood-count-cbc");
      ids.test = res.body.data._id;
      assert.equal((await admin("POST", "/api/v1/tests", { body })).status, 409);
      assert.equal((await admin("POST", "/api/v1/tests", { body: { name: "Bad Price", price: -1 } })).status, 400);
      assert.equal((await admin("POST", "/api/v1/tests", { body: { name: "No Price" } })).status, 400);
      const str = await admin("POST", "/api/v1/tests", { body: { name: "Lipid Profile", price: "799", isActive: false } });
      assert.equal(str.body.data.price, 799);
      ids.inactiveTest = str.body.data._id;
    });

    test("tests: list/search/filter for staff; public list shows active only without auth", async () => {
      const list = await staff("GET", "/api/v1/tests");
      assert.equal(list.body.data.length, 2);
      assert.equal((await staff("GET", "/api/v1/tests?isActive=true")).body.data.length, 1);
      assert.equal((await staff("GET", "/api/v1/tests?search=blood")).body.data.length, 1);
      const special = await staff("GET", `/api/v1/tests?search=${encodeURIComponent("(CBC")}`);
      assert.equal(special.status, 200, "special characters in search must not crash");
      const pub = await api("GET", "/api/v1/public/tests");
      assert.equal(pub.status, 200);
      assert.deepEqual(pub.body.data.map((t) => t.name), ["Complete Blood Count (CBC)"]);
    });

    test("tests: update (re-slugs on rename), staff forbidden, delete, 404", async () => {
      assert.equal((await staff("PATCH", `/api/v1/tests/${ids.test}`, { body: { price: 1 } })).status, 403);
      const res = await admin("PATCH", `/api/v1/tests/${ids.test}`, { body: { name: "CBC Test", price: 300 } });
      assert.equal(res.body.data.slug, "cbc-test");
      assert.equal(res.body.data.price, 300);
      assert.equal(res.body.data.category, "Haematology", "partial update keeps other fields");
      assert.equal((await admin("PATCH", `/api/v1/tests/${ids.test}`, { body: { price: -5 } })).status, 400);
      assert.equal((await admin("DELETE", `/api/v1/tests/${ids.inactiveTest}`)).status, 200);
      assert.equal((await admin("GET", `/api/v1/tests/${ids.inactiveTest}`)).status, 404);
    });

    test("packages: create with tests, populated on read, public list, discount pricing, admin-only", async () => {
      const body = { name: "Full Body Checkup", price: 1999, discountPrice: 1499, tests: [ids.test] };
      assert.equal((await staff("POST", "/api/v1/packages", { body })).status, 403);
      const res = await admin("POST", "/api/v1/packages", { body });
      assert.equal(res.status, 201);
      ids.pkg = res.body.data._id;
      const got = await staff("GET", `/api/v1/packages/${ids.pkg}`);
      assert.equal(got.body.data.tests[0].name, "CBC Test");
      assert.equal(got.body.data.discountPrice, 1499);
      assert.equal((await admin("POST", "/api/v1/packages", { body })).status, 409);
      assert.equal((await admin("POST", "/api/v1/packages", { body: { name: "Bad", price: -1 } })).status, 400);
      const pub = await api("GET", "/api/v1/public/packages");
      assert.equal(pub.body.data.length, 1);
      assert.equal(pub.body.data[0].tests[0].name, "CBC Test");
      const upd = await admin("PATCH", `/api/v1/packages/${ids.pkg}`, { body: { isActive: false } });
      assert.equal(upd.body.data.isActive, false);
      assert.equal(upd.body.data.price, 1999);
      assert.equal((await api("GET", "/api/v1/public/packages")).body.data.length, 0);
      const special = await staff("GET", `/api/v1/packages?search=${encodeURIComponent("Full+")}`);
      assert.equal(special.status, 200);
    });
  });

  // ==================================================================
  // APPOINTMENTS
  // ==================================================================
  describe("Appointments", () => {
    test("CRM create links an existing customer by mobile and populates test", async () => {
      const res = await staff("POST", "/api/v1/appointments", {
        body: { name: "Ravi Kumar", mobile: "919876543210", date: "2026-12-01", time: "10:00", test: ids.test, source: "crm" },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.data.customer, ids.customer);
      assert.equal(res.body.data.status, "pending");
      assert.match(res.body.data.appointmentId, /^APT-/);
      ids.appt = res.body.data._id;
      const got = await staff("GET", `/api/v1/appointments/${ids.appt}`);
      assert.equal(got.body.data.test.name, "CBC Test");
      assert.equal(got.body.data.customer.name, "Ravi Kumar");
    });

    test("validation: missing date / bad type / bad status → 400", async () => {
      assert.equal((await staff("POST", "/api/v1/appointments", { body: { name: "No Date", mobile: "9000000001" } })).status, 400);
      assert.equal((await staff("POST", "/api/v1/appointments", { body: { name: "Bad", mobile: "9000000001", date: "2026-12-01", type: "teleport" } })).status, 400);
      assert.equal((await staff("PATCH", `/api/v1/appointments/${ids.appt}`, { body: { status: "lost" } })).status, 400);
    });

    test("status change is audited; filters (type/status/date/search) work", async () => {
      await staff("POST", "/api/v1/appointments", { body: { name: "Home Person", mobile: "9000000200", date: "2026-12-02", type: "home_collection", address: "12 MG Road" } });
      const res = await staff("PATCH", `/api/v1/appointments/${ids.appt}`, { body: { status: "confirmed" } });
      assert.equal(res.body.data.status, "confirmed");
      assert.ok(await models.AuditLog.findOne({ entity: "Appointment", action: "status_change" }));
      assert.equal((await staff("GET", "/api/v1/appointments?type=home_collection")).body.data.length, 1);
      assert.equal((await staff("GET", "/api/v1/appointments?status=confirmed")).body.data.length, 1);
      assert.equal((await staff("GET", "/api/v1/appointments?date=2026-12-01")).body.data.length, 1);
      assert.equal((await staff("GET", "/api/v1/appointments?search=home")).body.data.length, 1);
      const plus = await staff("GET", `/api/v1/appointments?search=${encodeURIComponent("+91900")}`);
      assert.equal(plus.status, 200, "searching a +91 number must not crash");
    });

    test("delete is admin-only", async () => {
      assert.equal((await staff("DELETE", `/api/v1/appointments/${ids.appt}`)).status, 403);
      assert.equal((await admin("DELETE", `/api/v1/appointments/${ids.appt}`)).status, 200);
      assert.equal((await admin("DELETE", `/api/v1/appointments/${ids.appt}`)).status, 404);
    });

    test("public booking forces type/source and returns only the friendly id; home collection needs an address", async () => {
      const res = await api("POST", "/api/v1/public/appointments", {
        body: { name: "Web Visitor", mobile: "9000000300", date: "2026-12-05", type: "home_collection", source: "crm", status: "completed" },
      });
      assert.equal(res.status, 201);
      assert.deepEqual(Object.keys(res.body.data), ["appointmentId"]);
      const stored = await models.Appointment.findOne({ appointmentId: res.body.data.appointmentId });
      assert.equal(stored.type, "lab_visit");
      assert.equal(stored.source, "website");
      assert.equal(stored.status, "pending", "public callers cannot set status");
      assert.equal((await api("POST", "/api/v1/public/home-collection", { body: { name: "Web Visitor", mobile: "9000000300", date: "2026-12-05" } })).status, 400);
      const hc = await api("POST", "/api/v1/public/home-collection", { body: { name: "Web Visitor", mobile: "9000000300", date: "2026-12-05", address: "House 5, Sector 9" } });
      assert.equal(hc.status, 201);
    });
  });

  // ==================================================================
  // REPORTS & PRESCRIPTIONS (Cloudinary faked)
  // ==================================================================
  describe("Reports & prescriptions", () => {
    test("upload: file required, file type enforced (extension AND mime), success hides storage refs", async () => {
      assert.equal((await staff("POST", "/api/v1/reports", { form: (() => { const f = new FormData(); f.append("patientId", "P1"); return f; })() })).status, 400);
      const exe = fileForm({ patientId: "P1", mobile: "9876543210" }, { name: "x.exe", type: "application/pdf" });
      assert.equal((await staff("POST", "/api/v1/reports", { form: exe })).status, 400);
      const spoof = fileForm({ patientId: "P1", mobile: "9876543210" }, { name: "x.pdf", type: "text/html" });
      assert.equal((await staff("POST", "/api/v1/reports", { form: spoof })).status, 400);

      // Missing patientId / mobile must be rejected BEFORE anything is uploaded to storage.
      const uploadsBefore = cloudinaryService.uploadFile.mock.callCount();
      assert.equal((await staff("POST", "/api/v1/reports", { form: fileForm({ mobile: "9876543210" }) })).status, 400);
      assert.equal((await staff("POST", "/api/v1/reports", { form: fileForm({ patientId: "PAT-001" }) })).status, 400);
      assert.equal((await staff("POST", "/api/v1/reports", { form: fileForm({ patientId: "  ", mobile: "12" }) })).status, 400);
      assert.equal(cloudinaryService.uploadFile.mock.callCount(), uploadsBefore, "no orphaned upload for an invalid request");

      const ok = await staff("POST", "/api/v1/reports", { form: fileForm({ patientId: "PAT-001", mobile: "+91 98765 43210", test: "CBC" }) });
      assert.equal(ok.status, 201);
      assert.equal(ok.body.data.fileUrl, undefined);
      assert.equal(ok.body.data.filePublicId, undefined);
      assert.match(ok.body.data.downloadUrl, /^https:\/\/signed\.example\.test\//);
      assert.equal(ok.body.data.customer, ids.customer);
      assert.equal(ok.body.data.status, "available");
      ids.report = ok.body.data._id;
      assert.ok(await models.AuditLog.findOne({ entity: "Report", action: "upload" }));
    });

    test("list never exposes storage refs; search safe; update is whitelisted", async () => {
      const list = await staff("GET", "/api/v1/reports");
      assert.equal(list.status, 200);
      assert.equal(list.body.data[0].fileUrl, undefined);
      assert.equal(list.body.data[0].filePublicId, undefined);
      const plus = await staff("GET", `/api/v1/reports?search=${encodeURIComponent("+91")}`);
      assert.equal(plus.status, 200, "searching a +91 number must not crash");
      const upd = await staff("PATCH", `/api/v1/reports/${ids.report}`, { body: { status: "delivered", fileUrl: "https://evil.test/x", mobile: "1111111111" } });
      assert.equal(upd.status, 200);
      const stored = await models.Report.findById(ids.report);
      assert.equal(stored.status, "delivered");
      assert.equal(stored.fileUrl, "https://res.example.test/private/file.pdf");
      assert.equal(stored.mobile, "9876543210");
      assert.equal((await staff("PATCH", `/api/v1/reports/${ids.report}`, { body: { status: "lost" } })).status, 400);
      assert.equal((await api("GET", "/api/v1/reports")).status, 401);
    });

    test("public report search needs patientId AND mobile; pending reports are hidden; operators rejected", async () => {
      const ok = await api("POST", "/api/v1/public/reports/search", { body: { patientId: "PAT-001", mobile: "9876543210" } });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.data.length, 1);
      assert.deepEqual(Object.keys(ok.body.data[0]).sort(), ["downloadUrl", "patientId", "reportDate", "reportId", "status", "test"]);
      assert.equal((await api("POST", "/api/v1/public/reports/search", { body: { patientId: "PAT-001", mobile: "9000000000" } })).status, 404);
      assert.equal((await api("POST", "/api/v1/public/reports/search", { body: { patientId: { $ne: "" }, mobile: "9876543210" } })).status, 400);
      await models.Report.create({ reportId: "RPT-PEND", patientId: "PAT-002", mobile: "9876543210", status: "pending" });
      assert.equal((await api("POST", "/api/v1/public/reports/search", { body: { patientId: "PAT-002", mobile: "9876543210" } })).status, 404);
    });

    test("prescriptions: public upload → staff list/get (no storage refs); auth required for staff routes", async () => {
      const up = await api("POST", "/api/v1/public/prescriptions", { form: fileForm({ name: "Web Patient", mobile: "9000000400" }, { name: "rx.png", type: "image/png" }) });
      assert.equal(up.status, 201);
      assert.match(up.body.data.prescriptionId, /^PRES-/);
      assert.equal((await api("POST", "/api/v1/public/prescriptions", { form: fileForm({ name: "W" }, { name: "rx.png", type: "image/png" }) })).status, 400);
      assert.equal((await api("GET", "/api/v1/prescriptions")).status, 401);
      const list = await staff("GET", "/api/v1/prescriptions");
      assert.equal(list.body.data.length, 1);
      assert.equal(list.body.data[0].fileUrl, undefined);
      const one = await staff("GET", `/api/v1/prescriptions/${list.body.data[0]._id}`);
      assert.ok(one.body.data.downloadUrl);
      assert.equal(one.body.data.filePublicId, undefined);
      const plus = await staff("GET", `/api/v1/prescriptions?search=${encodeURIComponent("+91")}`);
      assert.equal(plus.status, 200, "searching a +91 number must not crash");
    });

    test("upload temp files are cleaned up", async () => {
      const dir = require("node:path").join(__dirname, "..", "uploads");
      await new Promise((r) => setTimeout(r, 100));
      const leftovers = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => !f.startsWith(".")) : [];
      const recent = leftovers.filter((f) => Date.now() - fs.statSync(require("node:path").join(dir, f)).mtimeMs < 120000);
      assert.deepEqual(recent, []);
    });
  });

  // ==================================================================
  // PUBLIC CONTACT, DASHBOARD, ACTIVITIES
  // ==================================================================
  describe("Public contact, dashboard, activities", () => {
    test("contact form creates a website lead; validation 400", async () => {
      const res = await api("POST", "/api/v1/public/contact", { body: { name: "Asker", mobile: "9000000500", message: "Do you do home visits?" } });
      assert.equal(res.status, 201);
      const lead = await models.Lead.findOne({ leadId: res.body.data.leadId });
      assert.equal(lead.source, "website");
      assert.equal(lead.notes, "Do you do home visits?");
      assert.equal((await api("POST", "/api/v1/public/contact", { body: { name: "A", mobile: "1" } })).status, 400);
    });

    test("dashboard stats match the database", async () => {
      assert.equal((await api("GET", "/api/v1/dashboard/stats")).status, 401);
      const res = await staff("GET", "/api/v1/dashboard/stats");
      assert.equal(res.status, 200);
      const { Customer, Lead, Appointment } = models;
      assert.equal(res.body.data.totalCustomers, await Customer.countDocuments({}));
      assert.equal(res.body.data.inactiveCustomers, 1);
      assert.equal(res.body.data.totalLeads, await Lead.countDocuments({}));
      assert.equal(res.body.data.pendingAppointments, await Appointment.countDocuments({ status: { $in: ["pending", "confirmed"] } }));
      assert.equal(res.body.data.totalTests, 1);
      assert.equal(res.body.data.totalPackages, 0);
      assert.equal(typeof res.body.data.totalCampaigns, "number");
    });

    test("activities: create (user taken from token), list filter, complete, validation", async () => {
      const res = await staff("POST", "/api/v1/activities", { body: { type: "call", title: "Called Ravi", customer: ids.customer } });
      assert.equal(res.status, 201);
      const me = await models.User.findOne({ email: "staff@test.local" });
      assert.equal(res.body.data.user, String(me._id));
      const list = await staff("GET", `/api/v1/activities?customer=${ids.customer}`);
      assert.equal(list.body.data.length, 1);
      assert.equal(list.body.data[0].user.name, "Staff One");
      const done = await staff("PATCH", `/api/v1/activities/${res.body.data._id}/complete`);
      assert.equal(done.body.data.completed, true);
      assert.equal((await staff("POST", "/api/v1/activities", { body: { type: "dance", title: "x" } })).status, 400);
      const spoof = await staff("POST", "/api/v1/activities", { body: { type: "note", title: "spoof", user: String(new mongoose.Types.ObjectId()) } });
      assert.equal(spoof.body.data.user, String(me._id), "client cannot attribute an activity to someone else");
      const custAct = await staff("GET", `/api/v1/customers/${ids.customer}/activity`);
      assert.equal(custAct.body.data.length, 1);
    });
  });

  // ==================================================================
  // SECURITY MIDDLEWARE & ERROR HANDLING
  // ==================================================================
  describe("Security middleware & error handling", () => {
    test("health endpoint reports DB state without secrets", async () => {
      const res = await api("GET", "/api/v1/health");
      assert.equal(res.status, 200);
      assert.equal(res.body.data.database, "connected");
      assert.doesNotMatch(res.text, /mongodb:\/\//);
    });

    test("unknown route → JSON 404; malformed JSON → 400", async () => {
      const nf = await api("GET", "/api/v1/nope");
      assert.equal(nf.status, 404);
      assert.equal(nf.body.success, false);
      const bad = await api("POST", "/api/v1/auth/login", { body: "{not json" });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.success, false);
    });

    test("helmet headers are set and X-Powered-By is hidden", async () => {
      const res = await api("GET", "/api/v1/health");
      assert.equal(res.headers.get("x-powered-by"), null);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.ok(res.headers.get("content-security-policy"));
    });

    test("CORS: allowed origin echoed with credentials; unknown origin rejected with 403", async () => {
      const ok = await api("GET", "/api/v1/health", { headers: { Origin: "http://localhost:5173" } });
      assert.equal(ok.headers.get("access-control-allow-origin"), "http://localhost:5173");
      assert.equal(ok.headers.get("access-control-allow-credentials"), "true");
      const pre = await api("OPTIONS", "/api/v1/customers", {
        headers: { Origin: "http://localhost:5173", "Access-Control-Request-Method": "PATCH", "Access-Control-Request-Headers": "authorization,content-type" },
      });
      assert.equal(pre.status, 204);
      const evil = await api("GET", "/api/v1/health", { headers: { Origin: "https://evil.example" } });
      assert.equal(evil.status, 403);
      assert.equal(evil.headers.get("access-control-allow-origin"), null);
    });

    test("mongo-sanitize strips $-operators from JSON bodies on non-validated routes", async () => {
      const res = await staff("POST", "/api/v1/activities", { body: { type: "note", title: "t", $where: "1", customer: { $gt: "" } } });
      // customer operator object is stripped to {} → cast error (400), never a query operator
      assert.ok([400, 201].includes(res.status));
      if (res.status === 201) assert.equal(res.body.data.customer, null);
    });
  });
});
