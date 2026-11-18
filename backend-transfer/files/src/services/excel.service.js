const XLSX = require("xlsx");
const fs = require("fs/promises");
const Customer = require("../models/Customer");
const generateId = require("../utils/generateId");
const ApiError = require("../utils/ApiError");
const { normalizePhone, isValidIndianMobile } = require("../utils/normalizePhone");

/** Hard cap per file so one upload can't exhaust memory or run for many minutes. */
const MAX_IMPORT_ROWS = 50000;
/** Errors/warnings returned to the client are capped; counts are always exact. */
const MAX_MESSAGES = 50;

/**
 * Default mapping from CRM fields to likely source column headers, compared
 * on aliasKey() (case/whitespace-insensitive, "_" and "-" read as spaces).
 * The client may send an explicit `columnMapping` { crmField: "Column Label" }
 * which wins; an explicit null/"" means "do not import this field".
 *
 * IDENTICAL to FIELD_ALIASES in frontend/src/utils/importWorkbook.ts.
 */
const DEFAULT_HEADER_ALIASES = {
  name: ["name", "full name", "customer name", "customer", "patient name", "patient"],
  mobile: ["mobile", "mobile number", "phone", "phone number", "contact", "contact number", "mobile no", "phone no"],
  whatsappNumber: ["whatsapp", "whatsapp number", "whatsapp no", "whatsapp mobile"],
  email: ["email", "email address", "e mail", "e mail address"],
  gender: ["gender", "sex"],
  dateOfBirth: ["dob", "date of birth", "birth date", "birthdate"],
  address: ["address", "full address", "customer address", "patient address"],
  city: ["city", "town"],
  state: ["state"],
  pincode: ["pincode", "pin code", "postal code", "zip", "zip code"],
  lastTest: ["last test", "test", "test name"],
};
const CRM_FIELDS = Object.keys(DEFAULT_HEADER_ALIASES);

// ======================================================
// Header handling — SHARED ALGORITHM with the frontend preview
// (frontend/src/utils/importWorkbook.ts). Both sides must produce the same
// labels so a mapping chosen in the browser matches on the server.
//
//  - the header row is the first non-blank row;
//  - headers are read by POSITION up to the last column that has a header
//    or any data; blank header cells keep their position and are labelled
//    "Column <letter>" (e.g. "Column C");
//  - label = whitespace collapsed + trimmed;
//  - duplicates (case-insensitive) get " (2)", " (3)" …;
//  - comparisons use headerKey(): the label lower-cased.
// ======================================================

function normalizeHeaderText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function headerKey(value) {
  return normalizeHeaderText(value).toLowerCase();
}

/** headerKey with "_" and "-" read as spaces — used only for alias auto-detect. */
function aliasKey(value) {
  return headerKey(value).replace(/[_-]/g, " ").replace(/\s+/g, " ").trim();
}

function buildHeaderLabels(headerRow, width) {
  const counts = new Map();
  const labels = [];
  for (let i = 0; i < width; i += 1) {
    const base = normalizeHeaderText(headerRow[i]) || `Column ${XLSX.utils.encode_col(i)}`;
    const key = base.toLowerCase();
    const n = (counts.get(key) || 0) + 1;
    counts.set(key, n);
    labels.push(n > 1 ? `${base} (${n})` : base);
  }
  return labels;
}

function isBlankCell(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

/**
 * Reads the first worksheet into { headers, rows } where every row is
 * { rowNumber, values: { [label]: cell } }.
 *
 *  - CSV is read with raw:true so values stay exactly as typed (no US-date
 *    or 9.19E+11 guessing for phone numbers / DD/MM/YYYY dates).
 *  - XLSX date cells come back as Date objects (cellDates).
 *  - Completely blank rows are skipped; rowNumber is the spreadsheet row.
 */
function readSheet(filePath) {
  const isCsv = /\.csv$/i.test(filePath);
  let workbook;
  try {
    workbook = XLSX.readFile(filePath, { cellDates: true, raw: isCsv, dense: true });
  } catch {
    throw ApiError.badRequest("The file could not be read as a spreadsheet. Please upload a valid .xlsx, .xls or .csv file.");
  }
  const sheetName = workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : null;
  if (!sheet) throw ApiError.badRequest("The file does not contain any worksheet.");

  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", blankrows: true, raw: true });
  // Spreadsheet row of matrix[0]: Excel starts the sheet range at the first used cell.
  const firstRow = sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]).s.r : 0;
  const headerIndex = matrix.findIndex((row) => Array.isArray(row) && !row.every(isBlankCell));
  if (headerIndex === -1) return { headers: [], rows: [] };
  const headerRow = matrix[headerIndex];

  // Width = last column (by position) with a header or any data.
  let width = 0;
  for (let r = headerIndex; r < matrix.length; r += 1) {
    const row = matrix[r] || [];
    for (let i = row.length - 1; i >= width; i -= 1) {
      if (!isBlankCell(row[i])) {
        width = i + 1;
        break;
      }
    }
  }
  const headers = buildHeaderLabels(headerRow, width);

  const rows = [];
  for (let r = headerIndex + 1; r < matrix.length; r += 1) {
    const cells = matrix[r] || [];
    if (cells.every(isBlankCell)) continue;
    // Null prototype: a header such as "__proto__" stays plain data.
    const values = Object.create(null);
    headers.forEach((label, i) => {
      values[label] = cells[i] ?? "";
    });
    rows.push({ rowNumber: firstRow + r + 1, values });
  }
  return { headers, rows };
}

/**
 * Reads the raw workbook and returns { headers, sampleRows, totalRows }
 * without applying any mapping — used so the client can build a
 * "map your columns" UI.
 */
function readWorkbookPreview(filePath, { maxRows = 5 } = {}) {
  const { headers, rows } = readSheet(filePath);
  return { headers, sampleRows: rows.slice(0, maxRows).map((r) => r.values), totalRows: rows.length };
}

/**
 * Resolves crmField → header label. Explicit mappings are matched
 * case/space-insensitively (so labels from the new preview AND raw headers
 * from older clients both work); unknown CRM fields are ignored. A field
 * sent as null/"" was set to "Not mapped" by the user and is never
 * auto-detected. Fields absent from the mapping are auto-detected from
 * DEFAULT_HEADER_ALIASES.
 */
function resolveColumnMapping(headers, explicitMapping = {}) {
  const labelByKey = new Map(headers.map((h) => [h.toLowerCase(), h]));
  const mapping = {};
  const warnings = [];
  const explicit = explicitMapping && typeof explicitMapping === "object" ? explicitMapping : {};
  const unmapped = new Set();

  for (const field of CRM_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(explicit, field)) continue;
    const wanted = explicit[field];
    if (wanted === null || wanted === undefined || String(wanted).trim() === "") {
      unmapped.add(field);
      continue;
    }
    const label = labelByKey.get(headerKey(wanted));
    if (label) mapping[field] = label;
    else warnings.push(`Mapped column "${normalizeHeaderText(wanted)}" for ${field} was not found in the file.`);
  }

  const keyed = headers.map((label) => ({ label, key: aliasKey(label) }));
  for (const field of CRM_FIELDS) {
    if (mapping[field] || unmapped.has(field)) continue;
    const match = keyed.find((h) => DEFAULT_HEADER_ALIASES[field].includes(h.key));
    if (match) mapping[field] = match.label;
  }
  return { mapping, warnings };
}

// ======================================================
// Date of birth
// ======================================================

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_MS = 86400000;

function utcDate(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  // Reject impossible dates such as 31/02/1990 (Date.UTC would roll over).
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date;
}

function expandYear(y) {
  if (y >= 100) return y;
  const currentYY = new Date().getUTCFullYear() % 100;
  return y > currentYY ? 1900 + y : 2000 + y;
}

/**
 * Parses a date-of-birth cell into a UTC-midnight Date.
 * Accepts: Excel date cells, Excel serial numbers, YYYY-MM-DD (also / or .),
 * DD/MM/YYYY (Indian day-first; also - or .), "15 Mar 1990" / "15-March-1990".
 * A month-first date is accepted only when unambiguous (e.g. 3/15/1990).
 * Rejects impossible dates, years before 1900 and dates in the future.
 *
 * @returns {{ date: Date|null, invalid: boolean }}
 */
function parseDateOfBirth(value) {
  if (isBlankCell(value)) return { date: null, invalid: false };
  let date = null;

  if (value instanceof Date) {
    if (!Number.isNaN(value.getTime())) {
      // Round to the nearest UTC day: SheetJS gives UTC midnight, but be
      // robust to a local-midnight Date in any timezone within ±12h.
      date = new Date(Math.round(value.getTime() / DAY_MS) * DAY_MS);
    }
  } else if (typeof value === "number") {
    if (value >= 1 && value < 2958466) {
      const p = XLSX.SSF.parse_date_code(value);
      date = p ? utcDate(p.y, p.m, p.d) : null;
    }
  } else {
    const s = String(value).trim();
    let m;
    if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/))) {
      date = utcDate(+m[1], +m[2], +m[3]);
    } else if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/))) {
      const a = +m[1];
      const b = +m[2];
      const y = expandYear(+m[3]);
      date = utcDate(y, b, a) || (b > 12 && a <= 12 ? utcDate(y, a, b) : null);
    } else if ((m = s.match(/^(\d{1,2})[-\s]+([A-Za-z]{3,9})[-\s,]+(\d{4})$/))) {
      const month = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
      date = month ? utcDate(+m[3], month, +m[1]) : null;
    }
  }

  if (!date) return { date: null, invalid: true };
  const year = date.getUTCFullYear();
  if (year < 1900 || date.getTime() > Date.now()) return { date: null, invalid: true };
  return { date, invalid: false };
}

function displayCell(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? "").trim();
}

/**
 * normalizePhone plus the domestic trunk prefix that spreadsheets often
 * carry ("09812345678"). Only stripped when the rest is a valid mobile, so
 * 11-digit landlines (e.g. 020 12345678) are left untouched. Import-only:
 * the shared normalizePhone is deliberately not changed.
 */
function normalizeImportPhone(value) {
  const digits = normalizePhone(value);
  if (digits.length === 11 && digits[0] === "0" && isValidIndianMobile(digits.slice(1))) return digits.slice(1);
  return digits;
}

// ======================================================
// Import
// ======================================================

/**
 * Imports customers from an uploaded Excel/CSV file.
 *
 *  - Validates name + Indian mobile per row (invalid rows are counted, not imported).
 *  - Duplicate mobiles / WhatsApp numbers — against the database and within
 *    the file — are counted as duplicates and skipped, so re-uploading the
 *    same file (e.g. after a dropped connection) never creates duplicates.
 *  - Date of birth is imported; an unrecognised DOB keeps the row but is
 *    reported in `warnings` / `dobInvalidCount`.
 *  - Inserts in batches (ordered:false); rows rejected by a unique index
 *    (a concurrent insert) are counted in skippedCount.
 *  - The uploaded temp file is always deleted, on success or failure.
 *
 * Returns { totalRows, successCount, duplicateCount, invalidCount,
 *           skippedCount, dobInvalidCount, errors, warnings, detectedMapping, durationMs }.
 */
async function importCustomersFromFile(filePath, { columnMapping = {}, batchSize = 1000 } = {}) {
  const startedAt = Date.now();
  try {
    const { headers, rows } = readSheet(filePath);

    if (rows.length > MAX_IMPORT_ROWS) {
      throw ApiError.badRequest(
        `File has ${rows.length} rows; the maximum per import is ${MAX_IMPORT_ROWS.toLocaleString("en-IN")}. Split the file.`
      );
    }

    const { mapping, warnings } = resolveColumnMapping(headers, columnMapping);
    const summary = {
      totalRows: rows.length,
      successCount: 0,
      duplicateCount: 0,
      invalidCount: 0,
      skippedCount: 0,
      dobInvalidCount: 0,
      errors: [],
      warnings: warnings.slice(0, MAX_MESSAGES),
      detectedMapping: mapping,
      durationMs: 0,
    };
    const pushError = (msg) => summary.errors.length < MAX_MESSAGES && summary.errors.push(msg);
    const pushWarning = (msg) => summary.warnings.length < MAX_MESSAGES && summary.warnings.push(msg);

    if (!mapping.name || !mapping.mobile) {
      summary.invalidCount = rows.length;
      summary.errors.push(
        "Could not detect required columns (name, mobile). Please map them explicitly, e.g. " +
          '{"name":"Full Name","mobile":"Phone"}.'
      );
      summary.durationMs = Date.now() - startedAt;
      return summary;
    }

    // Load existing keys once (fast Set lookups) instead of a query per row.
    const [existingMobileList, existingWhatsappList] = await Promise.all([
      Customer.distinct("mobile"),
      Customer.distinct("whatsappNumber"),
    ]);
    const existingMobiles = new Set(existingMobileList);
    const existingWhatsapp = new Set(existingWhatsappList.filter(Boolean));
    const seenMobiles = new Set();
    const seenWhatsapp = new Set();

    const text = (row, field) => (mapping[field] ? displayCell(row.values[mapping[field]]) : "");
    const validDocs = [];

    for (const row of rows) {
      const name = text(row, "name");
      const rawMobile = row.values[mapping.mobile];
      const mobile = normalizeImportPhone(displayCell(rawMobile));

      if (!name || !mobile || !isValidIndianMobile(mobile)) {
        summary.invalidCount += 1;
        pushError(`Row ${row.rowNumber}: invalid or missing name/mobile ("${name}" / "${displayCell(rawMobile)}")`);
        continue;
      }

      const whatsappNumber = mapping.whatsappNumber ? normalizeImportPhone(text(row, "whatsappNumber")) : "";
      if (existingMobiles.has(mobile) || seenMobiles.has(mobile)) {
        summary.duplicateCount += 1;
        continue;
      }
      if (whatsappNumber && (existingWhatsapp.has(whatsappNumber) || seenWhatsapp.has(whatsappNumber))) {
        summary.duplicateCount += 1;
        pushWarning(`Row ${row.rowNumber}: WhatsApp number already belongs to another customer; row skipped.`);
        continue;
      }
      seenMobiles.add(mobile);
      if (whatsappNumber) seenWhatsapp.add(whatsappNumber);

      let dateOfBirth = null;
      if (mapping.dateOfBirth) {
        const raw = row.values[mapping.dateOfBirth];
        const dob = parseDateOfBirth(raw);
        if (dob.invalid) {
          summary.dobInvalidCount += 1;
          pushWarning(
            `Row ${row.rowNumber}: date of birth "${displayCell(raw)}" not recognised (use DD/MM/YYYY or YYYY-MM-DD); imported without it.`
          );
        }
        dateOfBirth = dob.date;
      }

      validDocs.push({
        customerId: generateId("CUS"),
        name,
        mobile,
        whatsappNumber,
        email: text(row, "email").toLowerCase(),
        gender: mapping.gender ? normalizeGender(text(row, "gender")) : "",
        dateOfBirth,
        address: text(row, "address"),
        city: text(row, "city"),
        state: text(row, "state"),
        pincode: text(row, "pincode"),
        lastTest: text(row, "lastTest"),
        source: "import",
        status: "active",
      });
    }

    // Insert in batches to avoid one massive insert call.
    for (let i = 0; i < validDocs.length; i += batchSize) {
      const batch = validDocs.slice(i, i + batchSize);
      try {
        const inserted = await Customer.insertMany(batch, { ordered: false });
        summary.successCount += inserted.length;
      } catch (err) {
        // ordered:false still inserts the non-conflicting documents.
        const insertedCount = err.insertedDocs ? err.insertedDocs.length : 0;
        summary.successCount += insertedCount;
        summary.skippedCount += batch.length - insertedCount;
        pushError(
          `Batch of ${batch.length} rows: ${batch.length - insertedCount} not inserted (${
            err.code === 11000 ? "already exists" : err.message
          }).`
        );
      }
    }

    summary.durationMs = Date.now() - startedAt;
    return summary;
  } finally {
    await fs.unlink(filePath).catch(() => {});
  }
}

function normalizeGender(value) {
  const v = String(value || "").trim().toLowerCase();
  if (["m", "male"].includes(v)) return "male";
  if (["f", "female"].includes(v)) return "female";
  if (v) return "other";
  return "";
}

/**
 * Builds a workbook buffer for exporting a filtered set of customers.
 * Only exposes safe, relevant fields (no internal/system fields).
 */
function buildCustomerExportBuffer(customers) {
  const rows = customers.map((c) => ({
    "Customer ID": c.customerId,
    Name: c.name,
    Mobile: c.mobile,
    WhatsApp: c.whatsappNumber,
    Email: c.email,
    Gender: c.gender,
    "Date of Birth": c.dateOfBirth ? new Date(c.dateOfBirth).toISOString().slice(0, 10) : "",
    City: c.city,
    State: c.state,
    Pincode: c.pincode,
    "Last Test": c.lastTest,
    "Last Visit": c.lastVisit ? new Date(c.lastVisit).toISOString().slice(0, 10) : "",
    "Total Visits": c.totalVisits,
    "Total Amount": c.totalAmount,
    Status: c.status,
    Tags: (c.tags || []).join(", "),
    "Marketing Opt-In": c.marketingOptIn ? "Yes" : "No",
    "Created At": c.createdAt ? new Date(c.createdAt).toISOString().slice(0, 10) : "",
  }));
  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Customers");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

module.exports = {
  MAX_IMPORT_ROWS,
  DEFAULT_HEADER_ALIASES,
  normalizeHeaderText,
  headerKey,
  buildHeaderLabels,
  aliasKey,
  readWorkbookPreview,
  resolveColumnMapping,
  parseDateOfBirth,
  normalizeImportPhone,
  importCustomersFromFile,
  buildCustomerExportBuffer,
};
