/**
 * Customer import / export through the real HTTP endpoints, against an
 * isolated in-memory MongoDB (see helpers/memoryDb.js). All data is synthetic.
 *
 * Covers: blank-header preservation, header normalisation, DOB parsing and
 * persistence, blank rows, explicit column mapping (incl. "Column B" labels),
 * invalid / duplicate rows, temp-file cleanup on every path, one-import-at-a-
 * time 409, the row cap, and a 20,000-row XLSX import → export → CSV re-import.
 */
const { dbSuite, startDbApp } = require("./helpers/memoryDb");
const { test, before, after, describe, mock } = require("node:test");
const assert = require("node:assert/strict");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const XLSX = require("xlsx");

const UPLOADS = path.join(__dirname, "..", "uploads");
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const uploadsFiles = () => fsSync.readdirSync(UPLOADS).filter((f) => f !== ".gitkeep");

function xlsxBuffer(aoa) {
  const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

function form(buffer, { name = "customers.xlsx", type = XLSX_MIME, fields = {} } = {}) {
  const f = new FormData();
  Object.entries(fields).forEach(([k, v]) => f.append(k, v));
  f.append("file", new Blob([buffer], { type }), name);
  return f;
}

const csvBuffer = (lines) => Buffer.from(lines.join("\r\n"), "utf8");
const mobileFor = (i) => `9${String(i).padStart(9, "0")}`;

dbSuite("Customer import/export endpoints (isolated in-memory MongoDB)", () => {
  let h;
  let Customer;
  const tokens = {};
  const as = (who) => (m, p, o = {}) => h.api(m, p, { ...o, token: tokens[who] });
  let staff;
  let baselineUploads;

  before(async () => {
    h = await startDbApp();
    const User = require("../src/models/User");
    Customer = require("../src/models/Customer");
    await Promise.all([User.init(), Customer.init()]);
    await User.create({ name: "Staff One", email: "staff@test.local", password: "StaffPass123", role: "staff" });
    const r = await h.api("POST", "/api/v1/auth/login", { body: { email: "staff@test.local", password: "StaffPass123" } });
    assert.equal(r.status, 200);
    tokens.staff = r.body.data.token;
    staff = as("staff");
    baselineUploads = uploadsFiles();
  });

  after(async () => {
    mock.restoreAll();
    if (h) await h.stop();
  });

  const assertUploadsClean = () => assert.deepEqual(uploadsFiles(), baselineUploads, "temp upload files must be deleted");

  describe("small synthetic files", () => {
    before(async () => {
      await Customer.deleteMany({});
      await Customer.create({ customerId: "CUS-EXIST-1", name: "Existing", mobile: "9800000001", whatsappNumber: "9800000099" });
    });

    const SHEET = [
      ["  Full   Name ", "", "Phone", "Date of Birth", "City", "WhatsApp"],
      ["Asha Verma", "note-a", "98765 43210", new Date(Date.UTC(1990, 2, 15)), "Pune", ""],
      ["", "", "", "", "", ""], // blank row — skipped, not counted
      ["Ravi Kumar", "note-b", "+91 9876543211", "05/03/1985", "Delhi", ""],
      ["Bad Phone", "", "12345", "", "", ""], // invalid mobile
      ["No Name", "", "", "", "", ""], // invalid (name only, no mobile)
      ["Asha Again", "", "9876543210", "", "", ""], // duplicate within file
      ["Exists In DB", "", "9800000001", "", "", ""], // duplicate in DB
      ["WA Clash", "", "9876543212", "", "", "9800000099"], // whatsapp already used
      ["Bad Dob", "", "9876543213", "31/02/1990", "", ""], // imported without DOB
    ];

    test("preview keeps blank headers by position, normalises spacing, skips blank rows", async () => {
      const res = await staff("POST", "/api/v1/customers/import/preview", { form: form(xlsxBuffer(SHEET)) });
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.body.data.headers, ["Full Name", "Column B", "Phone", "Date of Birth", "City", "WhatsApp"]);
      assert.equal(res.body.data.totalRows, SHEET.length - 2, "header and the blank row are not data rows");
      assert.equal(res.body.data.sampleRows[0]["Column B"], "note-a");
      assertUploadsClean();
    });

    test("XLSX import: counts, DOB persistence, duplicates/invalid handled, temp file removed", async () => {
      const res = await staff("POST", "/api/v1/customers/import", { form: form(xlsxBuffer(SHEET)) });
      assert.equal(res.status, 200, res.text);
      const s = res.body.data;
      assert.equal(s.totalRows, 8);
      assert.equal(s.successCount, 3, JSON.stringify(s));
      assert.equal(s.invalidCount, 2);
      assert.equal(s.duplicateCount, 3);
      assert.equal(s.skippedCount, 0);
      assert.equal(s.dobInvalidCount, 1);
      assert.equal(s.detectedMapping.name, "Full Name");
      assert.equal(s.detectedMapping.dateOfBirth, "Date of Birth");
      assert.ok(s.errors.some((e) => /^Row 5:/.test(e)), "row numbers are spreadsheet rows (blank row counted)");
      assert.ok(s.warnings.some((w) => /Row 10: date of birth "31\/02\/1990"/.test(w)));
      assert.ok(s.warnings.some((w) => /Row 9: WhatsApp number/.test(w)));
      assert.equal(typeof s.durationMs, "number");

      const asha = await Customer.findOne({ mobile: "9876543210" }).lean();
      assert.equal(asha.name, "Asha Verma");
      assert.equal(asha.dateOfBirth.toISOString(), "1990-03-15T00:00:00.000Z");
      assert.equal(asha.city, "Pune");
      assert.equal(asha.source, "import");
      const ravi = await Customer.findOne({ mobile: "9876543211" }).lean();
      assert.equal(ravi.dateOfBirth.toISOString(), "1985-03-05T00:00:00.000Z", "DD/MM/YYYY is day-first");
      const bad = await Customer.findOne({ mobile: "9876543213" }).lean();
      assert.equal(bad.dateOfBirth, null);
      assertUploadsClean();
    });

    test("re-uploading the same file creates nothing (idempotent)", async () => {
      const before = await Customer.countDocuments();
      const res = await staff("POST", "/api/v1/customers/import", { form: form(xlsxBuffer(SHEET)) });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.successCount, 0);
      assert.equal(await Customer.countDocuments(), before);
      assertUploadsClean();
    });

    test("CSV import with an explicit mapping onto a blank-header column and messy header spacing", async () => {
      const csv = csvBuffer([
        "Patient  Name,,Contact No,DOB",
        "Meena Shah,Nashik,919812345670,1979-12-01",
        ",,,",
        "Kiran Rao,Thane,09812345671,15-Mar-1992",
      ]);
      const mapping = { name: "patient name", mobile: "Contact No", city: "Column B", dateOfBirth: "DOB", bogus: "x" };
      const res = await staff("POST", "/api/v1/customers/import", {
        form: form(csv, { name: "c.csv", type: "text/csv", fields: { columnMapping: JSON.stringify(mapping) } }),
      });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.data.totalRows, 2);
      assert.equal(res.body.data.successCount, 2, JSON.stringify(res.body.data));
      assert.deepEqual(res.body.data.warnings, []);
      const meena = await Customer.findOne({ mobile: "9812345670" }).lean();
      assert.equal(meena.city, "Nashik");
      assert.equal(meena.dateOfBirth.toISOString().slice(0, 10), "1979-12-01");
      const kiran = await Customer.findOne({ name: "Kiran Rao" }).lean();
      assert.ok(kiran, "leading-zero mobile in CSV kept as text and normalised");
      assert.equal(kiran.dateOfBirth.toISOString().slice(0, 10), "1992-03-15");
      assertUploadsClean();
    });

    test("a mapped column that is not in the file is reported as a warning", async () => {
      const csv = csvBuffer(["Name,Mobile", "Late Comer,9812345679"]);
      const res = await staff("POST", "/api/v1/customers/import", {
        form: form(csv, { name: "c.csv", type: "text/csv", fields: { columnMapping: JSON.stringify({ dateOfBirth: "Birthday" }) } }),
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.successCount, 1);
      assert.match(res.body.data.warnings[0], /Birthday/);
      assertUploadsClean();
    });

    test("missing required columns → 200 summary with every row invalid; temp file removed", async () => {
      const csv = csvBuffer(["Foo,Bar", "a,b", "c,d"]);
      const res = await staff("POST", "/api/v1/customers/import", { form: form(csv, { name: "c.csv", type: "text/csv" }) });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.invalidCount, 2);
      assert.equal(res.body.data.successCount, 0);
      assert.match(res.body.data.errors[0], /required columns/);
      assertUploadsClean();
    });

    test("invalid columnMapping (bad JSON / array / scalar) → 400 and temp file removed", async () => {
      for (const bad of ["{not json", "[]", "\"name\"", "null"]) {
        const res = await staff("POST", "/api/v1/customers/import", { form: form(xlsxBuffer(SHEET), { fields: { columnMapping: bad } }) });
        assert.equal(res.status, 400, `columnMapping=${bad}`);
        assertUploadsClean();
      }
    });

    test("corrupt workbook → 400, temp file removed", async () => {
      const res = await staff("POST", "/api/v1/customers/import", { form: form(Buffer.from("PK\u0003\u0004 definitely not a zip")) });
      assert.equal(res.status, 400);
      assert.match(res.body.message, /could not be read/);
      assertUploadsClean();
      const prev = await staff("POST", "/api/v1/customers/import/preview", { form: form(Buffer.from("PK\u0003\u0004 nope")) });
      assert.equal(prev.status, 400);
      assertUploadsClean();
    });

    test("'Not mapped' (null) is honoured end-to-end; leading blank rows keep real row numbers", async () => {
      const aoa = [[], [], ["Name", "Mobile", "City"], ["Null City", "9812300001", "Surat"], ["Broken", "123", "Surat"]];
      const res = await staff("POST", "/api/v1/customers/import", {
        form: form(xlsxBuffer(aoa), { fields: { columnMapping: JSON.stringify({ name: "Name", mobile: "Mobile", city: null }) } }),
      });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.data.successCount, 1);
      assert.equal(res.body.data.detectedMapping.city, undefined);
      assert.match(res.body.data.errors[0], /^Row 5:/, "header on spreadsheet row 3 → bad row is row 5");
      const c = await Customer.findOne({ mobile: "9812300001" }).lean();
      assert.equal(c.city, "", "city column was deliberately not imported");
      assertUploadsClean();
    });

    test("an empty sheet imports nothing", async () => {
      const res = await staff("POST", "/api/v1/customers/import", { form: form(csvBuffer(["Name,Mobile"]), { name: "e.csv", type: "text/csv" }) });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.totalRows, 0);
      assert.equal(res.body.data.successCount, 0);
      assertUploadsClean();
    });

    test("export includes the Date of Birth column", async () => {
      const res = await h.api("GET", "/api/v1/customers/export", { token: tokens.staff });
      assert.equal(res.status, 200);
      const exp = await fetch(`${h.base}/api/v1/customers/export`, { headers: { Authorization: `Bearer ${tokens.staff}` } });
      const wb = XLSX.read(Buffer.from(await exp.arrayBuffer()), { type: "buffer" });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
      const asha = rows.find((r) => String(r.Mobile) === "9876543210");
      assert.equal(asha["Date of Birth"], "1990-03-15");
    });
  });

  describe("one import at a time", () => {
    const excelService = require("../src/services/excel.service");

    test("a second import while one is running → 409; the lock is released after success and after failure", async () => {
      let release;
      let started;
      const startedP = new Promise((r) => (started = r));
      const gate = new Promise((r) => (release = r));
      const m = mock.method(excelService, "importCustomersFromFile", async (filePath) => {
        started();
        await gate;
        await fs.unlink(filePath).catch(() => {});
        return { totalRows: 0, successCount: 0, duplicateCount: 0, invalidCount: 0, skippedCount: 0, durationMs: 0 };
      });
      try {
        const csv = csvBuffer(["Name,Mobile", "X,9812340000"]);
        const first = staff("POST", "/api/v1/customers/import", { form: form(csv, { name: "a.csv", type: "text/csv" }) });
        await startedP;
        const second = await staff("POST", "/api/v1/customers/import", { form: form(csv, { name: "b.csv", type: "text/csv" }) });
        assert.equal(second.status, 409);
        assert.match(second.body.message, /already running/);
        release();
        assert.equal((await first).status, 200);
        assertUploadsClean();

        // released after success
        assert.equal((await staff("POST", "/api/v1/customers/import", { form: form(csv, { name: "c.csv", type: "text/csv" }) })).status, 200);

        // released after a failure inside the import
        m.mock.mockImplementation(async (filePath) => {
          await fs.unlink(filePath).catch(() => {});
          throw new Error("boom");
        });
        assert.equal((await staff("POST", "/api/v1/customers/import", { form: form(csv, { name: "d.csv", type: "text/csv" }) })).status, 500);
        m.mock.restore();
        const ok = await staff("POST", "/api/v1/customers/import", { form: form(csv, { name: "e.csv", type: "text/csv" }) });
        assert.equal(ok.status, 200, "lock released after the failed import");
        assertUploadsClean();
      } finally {
        m.mock.restore();
      }
    });
  });

  describe("upload size limits", () => {
    test("spreadsheet over 15 MB → 400 'File too large', nothing kept on disk", async () => {
      const big = Buffer.alloc(15 * 1024 * 1024 + 10, 0x41);
      const res = await staff("POST", "/api/v1/customers/import", { form: form(big, { name: "big.csv", type: "text/csv" }) });
      assert.equal(res.status, 400);
      assert.match(res.body.message, /File too large/i);
      assertUploadsClean();
    });

    test("public prescription over 10 MB → 400; missing patient details → 400; nothing kept on disk", async () => {
      const big = Buffer.alloc(10 * 1024 * 1024 + 10, 0x41);
      const tooBig = await h.api("POST", "/api/v1/public/prescriptions", {
        form: form(big, { name: "rx.pdf", type: "application/pdf", fields: { name: "Web Patient", mobile: "9000000400" } }),
      });
      assert.equal(tooBig.status, 400);
      assert.match(tooBig.body.message, /File too large/i);
      const noDetails = await h.api("POST", "/api/v1/public/prescriptions", { form: form(Buffer.from("%PDF-1.4"), { name: "rx.pdf", type: "application/pdf" }) });
      assert.equal(noDetails.status, 400);
      assertUploadsClean();
    });
  });

  describe("large files", () => {
    test("more than 50,000 data rows → 400, temp file removed, nothing inserted", async () => {
      const before = await Customer.countDocuments();
      const lines = ["Name,Mobile"];
      for (let i = 0; i < 50001; i += 1) lines.push(`P${i},${mobileFor(500000 + i)}`);
      const res = await staff("POST", "/api/v1/customers/import", { form: form(csvBuffer(lines), { name: "big.csv", type: "text/csv" }) });
      assert.equal(res.status, 400);
      assert.match(res.body.message, /maximum per import/);
      assert.equal(await Customer.countDocuments(), before);
      assertUploadsClean();
    });

    test("20,000-row XLSX import → export → CSV re-import of the same rows", { timeout: 300000 }, async () => {
      await Customer.deleteMany({});
      const N = 20000;
      const aoa = [["Name", "Mobile", "", "Date of Birth", "City"]];
      for (let i = 0; i < N; i += 1) {
        aoa.push([`Customer ${i}`, mobileFor(i), `x${i}`, `${String((i % 28) + 1).padStart(2, "0")}/0${(i % 9) + 1}/19${50 + (i % 50)}`, "Pune"]);
      }

      let t = Date.now();
      const imp = await staff("POST", "/api/v1/customers/import", { form: form(xlsxBuffer(aoa)) });
      const importMs = Date.now() - t;
      assert.equal(imp.status, 200, imp.text);
      assert.equal(imp.body.data.totalRows, N);
      assert.equal(imp.body.data.successCount, N, JSON.stringify({ ...imp.body.data, errors: imp.body.data.errors.slice(0, 3) }));
      assert.equal(imp.body.data.invalidCount + imp.body.data.duplicateCount + imp.body.data.skippedCount + imp.body.data.dobInvalidCount, 0);
      assert.equal(await Customer.countDocuments(), N);
      assert.equal(await Customer.countDocuments({ dateOfBirth: { $ne: null } }), N);
      assertUploadsClean();

      t = Date.now();
      const exp = await fetch(`${h.base}/api/v1/customers/export`, { headers: { Authorization: `Bearer ${tokens.staff}` } });
      assert.equal(exp.status, 200);
      const wb = XLSX.read(Buffer.from(await exp.arrayBuffer()), { type: "buffer" });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: false });
      const exportMs = Date.now() - t;
      assert.equal(rows.length, N);
      assert.equal(new Set(rows.map((r) => String(r.Mobile))).size, N);
      const r7 = rows.find((r) => String(r.Mobile) === mobileFor(7));
      assert.equal(r7["Date of Birth"], "1957-08-08");

      // Re-import the exported rows as CSV: every row is a duplicate.
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]]);
      t = Date.now();
      const re = await staff("POST", "/api/v1/customers/import", { form: form(Buffer.from(csv), { name: "export.csv", type: "text/csv" }) });
      const reimportMs = Date.now() - t;
      assert.equal(re.status, 200, re.text);
      assert.equal(re.body.data.totalRows, N);
      assert.equal(re.body.data.duplicateCount, N);
      assert.equal(re.body.data.successCount, 0);
      assert.equal(await Customer.countDocuments(), N);
      assertUploadsClean();

      console.log(`[20k] xlsx import ${importMs} ms · export ${exportMs} ms · csv re-import ${reimportMs} ms`);
    });
  });
});
