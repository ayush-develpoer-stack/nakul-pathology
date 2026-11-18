/**
 * Phase 2 regression tests (isolated in-memory MongoDB — see helpers/memoryDb.js).
 *
 *  1. Customer age / status / notes were silently dropped on create/update.
 *  2. Lead priority was not persisted.
 *  3. GET /leads ignored sortBy / sortOrder (and the priority filter).
 *  4. Assignable-user list for the follow-up/lead selectors, usable by staff,
 *     exposing only _id/name/role of active users.
 *  6. POST /activities accepted any body, incl. protected completion fields.
 *  7. Package discountPrice was not checked against price.
 *  8. Completing a follow-up via PATCH did not record completedAt/completedBy.
 */
const { dbSuite, startDbApp } = require("./helpers/memoryDb");
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");

dbSuite("Phase 2 regressions (isolated in-memory MongoDB)", () => {
  let h;
  let models;
  const tokens = {};
  const users = {};
  const as = (who) => (m, p, o = {}) => h.api(m, p, { ...o, token: tokens[who] });
  let admin;
  let staff;

  before(async () => {
    h = await startDbApp();
    models = {
      User: require("../src/models/User"),
      Customer: require("../src/models/Customer"),
      Lead: require("../src/models/Lead"),
      FollowUp: require("../src/models/FollowUp"),
      Activity: require("../src/models/Activity"),
      HealthPackage: require("../src/models/HealthPackage"),
    };
    await Promise.all(Object.values(models).map((m) => m.init()));
    users.admin = await models.User.create({ name: "Admin One", email: "admin@test.local", password: "AdminPass123", role: "admin" });
    users.staff = await models.User.create({ name: "Staff One", email: "staff@test.local", password: "StaffPass123", role: "staff", phone: "9000000001" });
    users.inactive = await models.User.create({ name: "Zed Inactive", email: "z@test.local", password: "ZedPass1234", isActive: false });
    for (const [who, email, password] of [["admin", "admin@test.local", "AdminPass123"], ["staff", "staff@test.local", "StaffPass123"]]) {
      const r = await h.api("POST", "/api/v1/auth/login", { body: { email, password } });
      assert.equal(r.status, 200);
      tokens[who] = r.body.data.token;
    }
    admin = as("admin");
    staff = as("staff");
  });

  after(async () => {
    if (h) await h.stop();
  });

  // ------------------------------------------------------------------
  describe("1. Customer age / status / notes", () => {
    test("create persists age (numeric string from the form), status and an initial note by the current user", async () => {
      const res = await staff("POST", "/api/v1/customers", {
        body: { name: "Asha Verma", mobile: "9811111111", age: "42", status: "inactive", notes: "Prefers home collection", dateOfBirth: "" },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.data.age, 42);
      assert.equal(res.body.data.status, "inactive");
      assert.equal(res.body.data.notes.length, 1);
      assert.equal(res.body.data.notes[0].text, "Prefers home collection");
      assert.equal(String(res.body.data.notes[0].addedBy), String(users.staff._id));
    });

    test("create without them keeps defaults (age null, active, no notes); empty age/notes are ignored", async () => {
      const res = await staff("POST", "/api/v1/customers", { body: { name: "No Extras", mobile: "9811111112", age: "", notes: "" } });
      assert.equal(res.status, 201);
      assert.equal(res.body.data.age, null);
      assert.equal(res.body.data.status, "active");
      assert.deepEqual(res.body.data.notes, []);
    });

    test("invalid age / status → 400 with the field named", async () => {
      for (const [field, value] of [["age", "abc"], ["age", "-1"], ["age", 200], ["status", "deleted"]]) {
        const res = await staff("POST", "/api/v1/customers", { body: { name: "Bad Value", mobile: "9811111113", [field]: value } });
        assert.equal(res.status, 400, `${field}=${value}`);
        assert.ok(res.body.errors.some((e) => e.field === field), `${field} error reported`);
      }
    });

    test("update changes age/status and APPENDS a note (existing notes kept); omitted fields untouched", async () => {
      const c = await models.Customer.findOne({ mobile: "9811111111" });
      const res = await staff("PATCH", `/api/v1/customers/${c._id}`, { body: { age: 43, status: "active", notes: "Called back" } });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.age, 43);
      assert.equal(res.body.data.status, "active");
      assert.deepEqual(res.body.data.notes.map((n) => n.text), ["Prefers home collection", "Called back"]);
      const again = await staff("PATCH", `/api/v1/customers/${c._id}`, { body: { city: "Agra", notes: "" } });
      assert.equal(again.body.data.notes.length, 2, "empty notes does not add or wipe notes");
      assert.equal(again.body.data.age, 43);
      const cleared = await staff("PATCH", `/api/v1/customers/${c._id}`, { body: { age: "" } });
      assert.equal(cleared.body.data.age, null, "empty age clears it");
    });
  });

  // ------------------------------------------------------------------
  describe("2 + 3. Lead priority, sorting and priority filter", () => {
    test("priority is persisted on create and update; '' clears; invalid → 400", async () => {
      const res = await staff("POST", "/api/v1/leads", { body: { name: "Prio High", mobile: "9822222201", priority: "high" } });
      assert.equal(res.status, 201);
      assert.equal(res.body.data.priority, "high");
      const upd = await staff("PATCH", `/api/v1/leads/${res.body.data._id}`, { body: { priority: "urgent" } });
      assert.equal(upd.body.data.priority, "urgent");
      const keep = await staff("PATCH", `/api/v1/leads/${res.body.data._id}`, { body: { notes: "x" } });
      assert.equal(keep.body.data.priority, "urgent", "omitted priority is unchanged");
      const clr = await staff("PATCH", `/api/v1/leads/${res.body.data._id}`, { body: { priority: "" } });
      assert.equal(clr.body.data.priority, null);
      assert.equal((await staff("POST", "/api/v1/leads", { body: { name: "Prio Bad", mobile: "9822222209", priority: "critical" } })).status, 400);
      await staff("PATCH", `/api/v1/leads/${res.body.data._id}`, { body: { priority: "high" } });
    });

    test("sortBy/sortOrder are applied (name, priority by rank, createdAt); invalid sortBy → 400", async () => {
      await staff("POST", "/api/v1/leads", { body: { name: "Aaron Low", mobile: "9822222202", priority: "low", status: "contacted" } });
      await staff("POST", "/api/v1/leads", { body: { name: "Zara Urgent", mobile: "9822222203", priority: "urgent" } });
      await staff("POST", "/api/v1/leads", { body: { name: "Mona Medium", mobile: "9822222204", priority: "medium" } });

      const nameAsc = await staff("GET", "/api/v1/leads?sortBy=name&sortOrder=asc");
      assert.equal(nameAsc.status, 200);
      assert.deepEqual(nameAsc.body.data.map((l) => l.name), ["Aaron Low", "Mona Medium", "Prio High", "Zara Urgent"]);
      const nameDesc = await staff("GET", "/api/v1/leads?sortBy=name&sortOrder=desc");
      assert.equal(nameDesc.body.data[0].name, "Zara Urgent");

      const prioDesc = await staff("GET", "/api/v1/leads?sortBy=priority&sortOrder=desc");
      assert.deepEqual(prioDesc.body.data.map((l) => l.priority), ["urgent", "high", "medium", "low"]);
      const prioAsc = await staff("GET", "/api/v1/leads?sortBy=priority&sortOrder=asc");
      assert.deepEqual(prioAsc.body.data.map((l) => l.priority), ["low", "medium", "high", "urgent"]);

      const newest = await staff("GET", "/api/v1/leads");
      assert.equal(newest.body.data[0].name, "Mona Medium", "default is newest first");
      const oldest = await staff("GET", "/api/v1/leads?sortBy=createdAt&sortOrder=asc");
      assert.equal(oldest.body.data[0].name, "Prio High");

      assert.equal((await staff("GET", "/api/v1/leads?sortBy=password")).status, 400);
      assert.equal((await staff("GET", "/api/v1/leads?sortOrder=sideways")).status, 400);
    });

    test("priority filter", async () => {
      const res = await staff("GET", "/api/v1/leads?priority=urgent");
      assert.deepEqual(res.body.data.map((l) => l.name), ["Zara Urgent"]);
      assert.equal((await staff("GET", "/api/v1/leads?priority=all")).body.data.length, 4);
    });
  });

  // ------------------------------------------------------------------
  describe("4. Assignable users for selectors", () => {
    test("staff and admin get active users with _id/name/role only; unauthenticated 401", async () => {
      assert.equal((await h.api("GET", "/api/v1/auth/users/assignable")).status, 401);
      for (const who of [staff, admin]) {
        const res = await who("GET", "/api/v1/auth/users/assignable");
        assert.equal(res.status, 200);
        assert.deepEqual(res.body.data.map((u) => u.name), ["Admin One", "Staff One"], "active only, sorted by name");
        res.body.data.forEach((u) => assert.deepEqual(Object.keys(u).sort(), ["_id", "name", "role"]));
      }
    });

    test("the full user list stays admin-only", async () => {
      assert.equal((await staff("GET", "/api/v1/auth/users")).status, 403);
    });
  });

  // ------------------------------------------------------------------
  describe("6. Activities validation", () => {
    test("valid activity is created; user/completed/completedAt from the client are ignored", async () => {
      const c = await models.Customer.findOne({ mobile: "9811111111" });
      const res = await staff("POST", "/api/v1/activities", {
        body: {
          type: "call", title: "Follow-up call", description: "Discussed report", customer: String(c._id),
          completed: true, completedAt: "2020-01-01T00:00:00.000Z", user: String(users.admin._id),
        },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.data.completed, false);
      assert.equal(res.body.data.completedAt, null);
      assert.equal(String(res.body.data.user), String(users.staff._id));
    });

    test("the lead-note shape used by the frontend still works", async () => {
      const lead = await models.Lead.findOne({ name: "Prio High" });
      const res = await staff("POST", "/api/v1/activities", { body: { lead: String(lead._id), type: "note", title: "Note", description: "hello" } });
      assert.equal(res.status, 201);
    });

    test("invalid type / missing title / bad ids / bad dueDate → 400 with field errors", async () => {
      const cases = [
        [{ type: "dance", title: "x" }, "type"],
        [{ type: "note" }, "title"],
        [{ type: "note", title: "   " }, "title"],
        [{ type: "note", title: "x", customer: "not-an-id" }, "customer"],
        [{ type: "note", title: "x", lead: { $ne: null } }, "lead"],
        [{ type: "note", title: "x", dueDate: "someday" }, "dueDate"],
      ];
      for (const [body, field] of cases) {
        const res = await staff("POST", "/api/v1/activities", { body });
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.ok(res.body.errors.some((e) => e.field === field), `${field} reported for ${JSON.stringify(body)}`);
      }
    });

    test("/complete still records completion server-side", async () => {
      const a = await models.Activity.findOne({ title: "Follow-up call" });
      const res = await staff("PATCH", `/api/v1/activities/${a._id}/complete`);
      assert.equal(res.body.data.completed, true);
      assert.ok(res.body.data.completedAt);
    });
  });

  // ------------------------------------------------------------------
  describe("7. Package discount validation", () => {
    let pkgId;
    test("create: discountPrice > price → 400 on discountPrice; equal or lower is fine; null allowed", async () => {
      const bad = await admin("POST", "/api/v1/packages", { body: { name: "Bad Discount", price: 1000, discountPrice: 1200 } });
      assert.equal(bad.status, 400);
      assert.ok(bad.body.errors.some((e) => e.field === "discountPrice"));
      const ok = await admin("POST", "/api/v1/packages", { body: { name: "Good Discount", price: 1000, discountPrice: 800 } });
      assert.equal(ok.status, 201);
      pkgId = ok.body.data._id;
      assert.equal((await admin("POST", "/api/v1/packages", { body: { name: "Same Price", price: 500, discountPrice: 500 } })).status, 201);
      assert.equal((await admin("POST", "/api/v1/packages", { body: { name: "No Discount", price: 500, discountPrice: null } })).status, 201);
    });

    test("update: checked against the stored price when only one side changes", async () => {
      const up = await admin("PATCH", `/api/v1/packages/${pkgId}`, { body: { discountPrice: 1500 } });
      assert.equal(up.status, 400);
      assert.ok(up.body.errors.some((e) => e.field === "discountPrice"));
      const lowerPrice = await admin("PATCH", `/api/v1/packages/${pkgId}`, { body: { price: 700 } });
      assert.equal(lowerPrice.status, 400, "lowering price below the existing discount is rejected");
      const both = await admin("PATCH", `/api/v1/packages/${pkgId}`, { body: { price: 700, discountPrice: 650 } });
      assert.equal(both.status, 200);
      const removeDiscount = await admin("PATCH", `/api/v1/packages/${pkgId}`, { body: { discountPrice: null, price: 100 } });
      assert.equal(removeDiscount.status, 200);
      const stored = await models.HealthPackage.findById(pkgId);
      assert.equal(stored.price, 100);
      assert.equal(stored.discountPrice, null);
      assert.equal((await admin("PATCH", "/api/v1/packages/65c000000000000000000fff", { body: { discountPrice: 1 } })).status, 404);
    });
  });

  // ------------------------------------------------------------------
  describe("8. Follow-up completion via PATCH", () => {
    let fuId;
    let leadId;
    test("PATCH status=completed records completedAt + completedBy and recomputes lead.nextFollowUpDate", async () => {
      const lead = await staff("POST", "/api/v1/leads", { body: { name: "FU Lead", mobile: "9833333301" } });
      leadId = lead.body.data._id;
      const when = new Date(Date.now() + 86400000).toISOString();
      const later = new Date(Date.now() + 5 * 86400000).toISOString();
      const fu = await staff("POST", "/api/v1/follow-ups", { body: { leadId, date: when } });
      await staff("POST", "/api/v1/follow-ups", { body: { leadId, date: later } });
      fuId = fu.body.data._id;

      const res = await staff("PATCH", `/api/v1/follow-ups/${fuId}`, { body: { status: "completed" } });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.status, "completed");
      assert.ok(res.body.data.completedAt, "completedAt recorded");
      assert.equal(String(res.body.data.completedBy?._id ?? res.body.data.completedBy), String(users.staff._id));
      const l = await models.Lead.findById(leadId);
      assert.equal(l.nextFollowUpDate.toISOString(), later);
    });

    test("client-supplied completedAt/completedBy are ignored", async () => {
      const res = await admin("PATCH", `/api/v1/follow-ups/${fuId}`, {
        body: { description: "edit", completedBy: String(users.admin._id), completedAt: "2001-01-01T00:00:00.000Z" },
      });
      assert.equal(res.status, 200);
      assert.equal(String(res.body.data.completedBy?._id ?? res.body.data.completedBy), String(users.staff._id));
      assert.notEqual(new Date(res.body.data.completedAt).getUTCFullYear(), 2001);
    });

    test("re-opening (pending) clears completion fields; /complete and PATCH agree", async () => {
      const reopened = await staff("PATCH", `/api/v1/follow-ups/${fuId}`, { body: { status: "pending" } });
      assert.equal(reopened.body.data.completedAt, null);
      assert.equal(reopened.body.data.completedBy, null);
      const viaComplete = await admin("PATCH", `/api/v1/follow-ups/${fuId}/complete`);
      assert.equal(String(viaComplete.body.data.completedBy?._id ?? viaComplete.body.data.completedBy), String(users.admin._id));
      assert.ok(viaComplete.body.data.completedAt);
    });
  });
});
