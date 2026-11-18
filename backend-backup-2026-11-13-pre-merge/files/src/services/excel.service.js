const XLSX = require("xlsx");
const fs = require("fs/promises");
const Customer = require("../models/Customer");
const generateId = require("../utils/generateId");
const { normalizePhone, isValidIndianMobile } = require("../utils/normalizePhone");

/**
 * Default mapping from expected CRM fields to a list of likely source
 * column header names (case-insensitive). The admin can override this
 * with a custom `columnMapping` object: { crmField: "Excel Column Name" }.
 */
const DEFAULT_HEADER_ALIASES = {
  name: ["name", "full name", "patient name", "customer name"],
  mobile: ["mobile", "phone", "phone number", "mobile number", "contact", "contact number"],
  whatsappNumber: ["whatsapp", "whatsapp number", "whatsapp no"],
  email: ["email", "email address", "e-mail"],
  gender: ["gender", "sex"],
  dateOfBirth: ["dob", "date of birth", "birth date"],
  address: ["address", "full address"],
  city: ["city", "town"],
  state: ["state"],
  pincode: ["pincode", "pin code", "zip", "zip code"],
  lastTest: ["last test", "test", "test name"],
};

function normalizeHeader(header) {
  return String(header || "").trim().toLowerCase();
}

/**
 * Reads the raw workbook and returns { headers, rows } without applying
 * any mapping — used so the client can build a "map your columns" UI.
 */
function readWorkbookPreview(filePath, { maxRows = 5 } = {}) {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  const headers = rows.length ? Object.keys(rows[0]) : [];
  return { headers, sampleRows: rows.slice(0, maxRows), totalRows: rows.length };
}

/**
 * Resolves a columnMapping (crmField -> source header) automatically
 * using DEFAULT_HEADER_ALIASES when an explicit mapping isn't supplied.
 */
function resolveColumnMapping(headers, explicitMapping = {}) {
  const mapping = { ...explicitMapping };
  const normalizedHeaders = headers.map((h) => ({ raw: h, normalized: normalizeHeader(h) }));

  Object.entries(DEFAULT_HEADER_ALIASES).forEach(([crmField, aliases]) => {
    if (mapping[crmField]) return; // explicit mapping wins
    const match = normalizedHeaders.find((h) => aliases.includes(h.normalized));
    if (match) mapping[crmField] = match.raw;
  });

  return mapping;
}

/**
 * Processes an uploaded Excel/CSV file of customers in batches.
 * Designed for ~20,000 rows: streams through in-memory rows but writes
 * to MongoDB using bulkWrite in chunks so it doesn't block the event
 * loop for a long single synchronous pass or open 20k individual
 * connections/queries.
 *
 * Returns a summary: { totalRows, successCount, duplicateCount, invalidCount, skippedCount, errors }
 */
async function importCustomersFromFile(filePath, { columnMapping = {}, batchSize = 500 } = {}) {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  const headers = rows.length ? Object.keys(rows[0]) : [];
  const mapping = resolveColumnMapping(headers, columnMapping);

  if (!mapping.name || !mapping.mobile) {
    await fs.unlink(filePath).catch(() => {});
    return {
      totalRows: rows.length,
      successCount: 0,
      duplicateCount: 0,
      invalidCount: rows.length,
      skippedCount: 0,
      errors: [
        "Could not detect required columns (name, mobile). Please provide an explicit columnMapping, e.g. " +
          '{"name":"Full Name","mobile":"Phone"}.',
      ],
      detectedMapping: mapping,
    };
  }

  const summary = {
    totalRows: rows.length,
    successCount: 0,
    duplicateCount: 0,
    invalidCount: 0,
    skippedCount: 0,
    errors: [],
    detectedMapping: mapping,
  };

  // Pre-load existing mobile numbers once (fast lookups) rather than a
  // query per row, which would be extremely slow at 20k rows.
  const existingMobiles = new Set(await Customer.distinct("mobile"));

  const validDocs = [];
  const seenInFileMobiles = new Set();

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const name = String(row[mapping.name] || "").trim();
    const rawMobile = row[mapping.mobile];
    const mobile = normalizePhone(rawMobile);

    if (!name || !mobile || !isValidIndianMobile(mobile)) {
      summary.invalidCount += 1;
      if (summary.errors.length < 50) {
        summary.errors.push(`Row ${i + 2}: invalid or missing name/mobile ("${name}" / "${rawMobile}")`);
      }
      continue;
    }

    if (existingMobiles.has(mobile) || seenInFileMobiles.has(mobile)) {
      summary.duplicateCount += 1;
      continue;
    }
    seenInFileMobiles.add(mobile);

    validDocs.push({
      customerId: generateId("CUS"),
      name,
      mobile,
      whatsappNumber: mapping.whatsappNumber ? normalizePhone(row[mapping.whatsappNumber]) : "",
      email: mapping.email ? String(row[mapping.email] || "").trim().toLowerCase() : "",
      gender: mapping.gender ? normalizeGender(row[mapping.gender]) : "",
      address: mapping.address ? String(row[mapping.address] || "").trim() : "",
      city: mapping.city ? String(row[mapping.city] || "").trim() : "",
      state: mapping.state ? String(row[mapping.state] || "").trim() : "",
      pincode: mapping.pincode ? String(row[mapping.pincode] || "").trim() : "",
      lastTest: mapping.lastTest ? String(row[mapping.lastTest] || "").trim() : "",
      source: "import",
      status: "active",
    });
  }

  // Insert in batches to avoid one massive 20k-document insert call.
  for (let i = 0; i < validDocs.length; i += batchSize) {
    const batch = validDocs.slice(i, i + batchSize);
    try {
      const inserted = await Customer.insertMany(batch, { ordered: false });
      summary.successCount += inserted.length;
    } catch (err) {
      // insertMany with ordered:false still inserts non-conflicting docs
      // and reports how many succeeded via err.insertedDocs / result.
      const insertedCount = err.insertedDocs ? err.insertedDocs.length : 0;
      summary.successCount += insertedCount;
      summary.skippedCount += batch.length - insertedCount;
      if (summary.errors.length < 50) {
        summary.errors.push(`Batch starting at row ${i + 2}: ${err.message}`);
      }
    }
  }

  await fs.unlink(filePath).catch(() => {});
  return summary;
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
  readWorkbookPreview,
  resolveColumnMapping,
  importCustomersFromFile,
  buildCustomerExportBuffer,
};
