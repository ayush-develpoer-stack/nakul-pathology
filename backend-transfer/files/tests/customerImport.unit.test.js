/**
 * Customer import: header algorithm (shared with the frontend preview) and
 * date-of-birth parsing. Pure functions — no database.
 */
require("./helpers/setup");
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const XLSX = require("xlsx");
const {
  buildHeaderLabels,
  aliasKey,
  readWorkbookPreview,
  DEFAULT_HEADER_ALIASES,
  headerKey,
  resolveColumnMapping,
  parseDateOfBirth,
  normalizeImportPhone,
} = require("../src/services/excel.service");

const iso = (r) => (r.date ? r.date.toISOString().slice(0, 10) : null);

describe("Import header labels (shared algorithm)", () => {
  test("blank header cells keep their position and get a column-letter label", () => {
    assert.deepEqual(buildHeaderLabels(["Name", "", "Phone", null, "City"], 5), ["Name", "Column B", "Phone", "Column D", "City"]);
    assert.deepEqual(buildHeaderLabels(["Name"], 3), ["Name", "Column B", "Column C"], "data wider than the header row");
  });

  test("whitespace is collapsed/trimmed; duplicates (case-insensitive) are suffixed", () => {
    assert.deepEqual(buildHeaderLabels(["  Full   Name ", "\tPhone\n"], 2), ["Full Name", "Phone"]);
    assert.deepEqual(buildHeaderLabels(["Name", "name", "NAME"], 3), ["Name", "name (2)", "NAME (3)"]);
  });

  test("headerKey ignores case and spacing", () => {
    assert.equal(headerKey("  Full   NAME "), "full name");
  });

  test("mapping: explicit labels and legacy raw headers resolve case/space-insensitively; unknown fields ignored", () => {
    const headers = buildHeaderLabels(["Patient  Name", "", "Contact No", "D.O.B"], 4);
    const { mapping, warnings } = resolveColumnMapping(headers, {
      name: "patient name",
      mobile: "  CONTACT   NO ",
      dateOfBirth: "D.O.B",
      __proto__: "x",
      isAdmin: "Column B",
    });
    assert.deepEqual(mapping, { name: "Patient Name", mobile: "Contact No", dateOfBirth: "D.O.B" });
    assert.deepEqual(warnings, []);
    assert.equal({}.isAdmin, undefined);
  });

  test("mapping: a mapped column missing from the file is reported and auto-detect still applies", () => {
    const { mapping, warnings } = resolveColumnMapping(["Name", "Mobile"], { mobile: "Phone 2" });
    assert.deepEqual(mapping, { name: "Name", mobile: "Mobile" });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Phone 2/);
  });

  test("auto-detect is case/space-insensitive and includes DOB", () => {
    const { mapping } = resolveColumnMapping(buildHeaderLabels([" FULL NAME", "phone  number", "Date of  Birth"], 3));
    assert.deepEqual(mapping, { name: "FULL NAME", mobile: "phone number", dateOfBirth: "Date of Birth" });
  });
});

describe("Date of birth parsing", () => {
  test("accepted formats", () => {
    assert.equal(iso(parseDateOfBirth(new Date(Date.UTC(1990, 2, 15)))), "1990-03-15");
    assert.equal(iso(parseDateOfBirth(new Date(1990, 2, 15))), "1990-03-15", "local-midnight Date");
    assert.equal(iso(parseDateOfBirth("1990-03-15")), "1990-03-15");
    assert.equal(iso(parseDateOfBirth("1990/3/5")), "1990-03-05");
    assert.equal(iso(parseDateOfBirth("15/03/1990")), "1990-03-15", "DD/MM/YYYY (day first)");
    assert.equal(iso(parseDateOfBirth("05-03-1990")), "1990-03-05", "05-03 is 5 March, not May 3");
    assert.equal(iso(parseDateOfBirth("15.03.1990")), "1990-03-15");
    assert.equal(iso(parseDateOfBirth("3/15/1990")), "1990-03-15", "unambiguous month-first");
    assert.equal(iso(parseDateOfBirth("15/03/90")), "1990-03-15", "2-digit year");
    assert.equal(iso(parseDateOfBirth("15 Mar 1990")), "1990-03-15");
    assert.equal(iso(parseDateOfBirth("15-March-1990")), "1990-03-15");
    assert.equal(iso(parseDateOfBirth(32947)), "1990-03-15", "Excel serial number");
    assert.equal(iso(parseDateOfBirth("1990-03-15T00:00:00.000Z")), "1990-03-15");
  });

  test("blank is not an error", () => {
    for (const v of ["", "   ", null, undefined]) assert.deepEqual(parseDateOfBirth(v), { date: null, invalid: false });
  });

  test("invalid, impossible, too old and future dates are rejected", () => {
    const future = new Date(Date.now() + 5 * 86400000);
    for (const v of ["31/02/1990", "not a date", "1990-13-01", "15/15/1990", "01/01/1850", future, "2999-01-01", -5, "15 Foo 1990"]) {
      const r = parseDateOfBirth(v);
      assert.equal(r.invalid, true, `expected invalid: ${String(v)}`);
      assert.equal(r.date, null);
    }
  });

  test("SheetJS xlsx date cells round-trip as the same calendar day", () => {
    const ws = XLSX.utils.aoa_to_sheet([["DOB"], [new Date(Date.UTC(2001, 11, 31))]], { cellDates: true });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "S");
    const back = XLSX.read(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }), { type: "buffer", cellDates: true });
    const cell = XLSX.utils.sheet_to_json(back.Sheets.S, { header: 1, raw: true })[1][0];
    assert.equal(iso(parseDateOfBirth(cell)), "2001-12-31");
  });
});

describe("Import phone normalisation", () => {
  test("strips +91 / 91 / 091 and a domestic trunk 0 before a valid mobile", () => {
    for (const v of ["9812345678", "+91 98123 45678", "919812345678", "0919812345678", "09812345678", "098123-45678"]) {
      assert.equal(normalizeImportPhone(v), "9812345678", v);
    }
  });

  test("11-digit landlines with a leading 0 are left untouched", () => {
    assert.equal(normalizeImportPhone("020 12345678"), "02012345678");
    assert.equal(normalizeImportPhone("01112345678"), "01112345678");
  });
});

describe("Mapping: explicit 'Not mapped' and alias normalisation", () => {
  test("a field sent as null or \"\" is never auto-detected (user chose 'Not mapped')", () => {
    const headers = ["Name", "Mobile", "City", "Email"];
    const { mapping } = resolveColumnMapping(headers, { name: "Name", mobile: "Mobile", city: null, email: "" });
    assert.deepEqual(mapping, { name: "Name", mobile: "Mobile" });
  });

  test("fields absent from the mapping are still auto-detected (older clients)", () => {
    assert.deepEqual(resolveColumnMapping(["Name", "Mobile", "City"], { name: "Name" }).mapping, { name: "Name", mobile: "Mobile", city: "City" });
  });

  test("auto-detect treats _ and - as spaces and covers the frontend aliases", () => {
    const { mapping } = resolveColumnMapping(["Patient", "Mobile_No", "E-Mail", "Sex", "Birthdate", "Postal-Code", "WhatsApp Mobile", "Patient Address", "Town"]);
    assert.deepEqual(mapping, {
      name: "Patient",
      mobile: "Mobile_No",
      email: "E-Mail",
      gender: "Sex",
      dateOfBirth: "Birthdate",
      pincode: "Postal-Code",
      whatsappNumber: "WhatsApp Mobile",
      address: "Patient Address",
      city: "Town",
    });
    assert.equal(aliasKey("  E_-Mail  Address "), "e mail address");
  });

  test("aliases are already in aliasKey form (otherwise they could never match)", () => {
    for (const aliases of Object.values(DEFAULT_HEADER_ALIASES)) for (const a of aliases) assert.equal(aliasKey(a), a);
  });
});

describe("Sheet reading", () => {
  const os = require("node:os");
  const fs = require("node:fs");
  const path = require("node:path");
  const tmp = (name, buf) => {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "imp-")), name);
    fs.writeFileSync(p, buf);
    return p;
  };

  test("leading blank rows: header is the first non-blank row; row numbers are spreadsheet rows", () => {
    const ws = XLSX.utils.aoa_to_sheet([[], [], ["Name", "", "Mobile"], ["Asha", "x", "9876543210"]]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "S");
    const p = tmp("a.xlsx", XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    const prev = readWorkbookPreview(p);
    assert.deepEqual(prev.headers, ["Name", "Column B", "Mobile"]);
    assert.equal(prev.totalRows, 1);
    assert.equal(prev.sampleRows[0].Mobile, "9876543210");

    const csv = tmp("b.csv", Buffer.from(",,\nName,,Mobile\nAsha,x,9876543210\n"));
    assert.deepEqual(readWorkbookPreview(csv).headers, ["Name", "Column B", "Mobile"]);
  });

  test("a '__proto__' header is plain data, not a prototype", () => {
    const p = tmp("c.csv", Buffer.from("Name,__proto__,Mobile\nAsha,evil,9876543210\n"));
    const row = readWorkbookPreview(p).sampleRows[0];
    assert.equal(row.__proto__, "evil");
    assert.equal(Object.getPrototypeOf(row), null);
    assert.equal({}.evil, undefined);
  });

  test("trailing formatted-but-empty columns do not create extra headers", () => {
    const ws = XLSX.utils.aoa_to_sheet([["Name", "Mobile", "", ""], ["Asha", "9876543210", "", ""]]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "S");
    const p = tmp("d.xlsx", XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    assert.deepEqual(readWorkbookPreview(p).headers, ["Name", "Mobile"]);
  });

  test("a sheet with no non-blank rows has no headers and no rows", () => {
    const p = tmp("e.csv", Buffer.from(",,\n,,\n"));
    assert.deepEqual(readWorkbookPreview(p), { headers: [], sampleRows: [], totalRows: 0 });
  });
});
