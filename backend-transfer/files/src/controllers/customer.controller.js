const fs = require("fs/promises");
const Customer = require("../models/Customer");
const Activity = require("../models/Activity");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");
const apiResponse = require("../utils/apiResponse");
const { parsePagination, buildPaginationMeta } = require("../utils/pagination");
const customerService = require("../services/customer.service");
const excelService = require("../services/excel.service");
const { normalizePhone } = require("../utils/normalizePhone");
const { recordAudit } = require("../utils/auditLog");

// POST /api/v1/customers
const createCustomer = asyncHandler(async (req, res) => {
  const existing = await customerService.findExistingCustomer(req.body);
  if (existing) {
    throw ApiError.conflict("A customer with this mobile/WhatsApp number already exists.", [
      { field: "mobile", message: `Existing customer: ${existing.customerId}` },
    ]);
  }

  // `notes` arrives from the form as plain text; the model stores an array
  // of { text, addedBy } entries.
  const { notes, ...data } = req.body;
  data.notes = notes ? [{ text: notes, addedBy: req.user._id }] : [];

  const customer = await customerService.createCustomer(data);

  await recordAudit({
    user: req.user,
    action: "create",
    entity: "Customer",
    entityId: customer.customerId,
    description: `Created customer ${customer.name} (${customer.customerId})`,
  });

  apiResponse.created(res, "Customer created successfully", customer);
});

// GET /api/v1/customers
const listCustomers = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = customerService.buildCustomerFilter(req.query);

  const sortField = req.query.sortBy || "createdAt";
  const sortOrder = req.query.sortOrder === "asc" ? 1 : -1;

  const [customers, total] = await Promise.all([
    Customer.find(filter).sort({ [sortField]: sortOrder }).skip(skip).limit(limit),
    Customer.countDocuments(filter),
  ]);

  apiResponse.success(res, {
    message: "Customers fetched",
    data: customers,
    pagination: buildPaginationMeta({ page, limit, total }),
  });
});

// GET /api/v1/customers/:id
const getCustomer = asyncHandler(async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) throw ApiError.notFound("Customer not found.");
  apiResponse.success(res, { message: "Customer fetched", data: customer });
});

// PATCH /api/v1/customers/:id
const updateCustomer = asyncHandler(async (req, res) => {
  const existingCustomer = await Customer.findById(req.params.id);
  if (!existingCustomer) throw ApiError.notFound("Customer not found.");

  const { notes, ...updates } = req.body;
  // A non-empty note from the edit form is appended, never replacing history.
  if (notes) updates.$push = { notes: { text: notes, addedBy: req.user._id } };
  if (updates.mobile) updates.mobile = normalizePhone(updates.mobile);
  if (updates.whatsappNumber) updates.whatsappNumber = normalizePhone(updates.whatsappNumber);

  // If mobile or whatsappNumber is being changed, make sure no OTHER
  // customer already uses it before saving (application-level check; the
  // unique indexes on the model are the database-level safety net).
  if (updates.mobile || updates.whatsappNumber) {
    const duplicate = await customerService.findDuplicateCustomerExcludingId({
      mobile: updates.mobile,
      whatsappNumber: updates.whatsappNumber,
      excludeId: existingCustomer._id,
    });
    if (duplicate) {
      const conflictField = duplicate.mobile === updates.mobile ? "mobile" : "whatsappNumber";
      throw ApiError.conflict(
        "Another customer already uses this mobile/WhatsApp number.",
        [{ field: conflictField, message: `Existing customer: ${duplicate.customerId}` }]
      );
    }
  }

  const customer = await Customer.findByIdAndUpdate(req.params.id, updates, {
    new: true,
    runValidators: true,
  });

  await recordAudit({
    user: req.user,
    action: "update",
    entity: "Customer",
    entityId: customer.customerId,
    description: `Updated customer ${customer.name} (${customer.customerId})`,
  });

  apiResponse.success(res, { message: "Customer updated", data: customer });
});

// DELETE /api/v1/customers/:id
const deleteCustomer = asyncHandler(async (req, res) => {
  const customer = await Customer.findByIdAndDelete(req.params.id);
  if (!customer) throw ApiError.notFound("Customer not found.");

  await recordAudit({
    user: req.user,
    action: "delete",
    entity: "Customer",
    entityId: customer.customerId,
    description: `Deleted customer ${customer.name} (${customer.customerId})`,
  });

  apiResponse.success(res, { message: "Customer deleted" });
});

// PATCH /api/v1/customers/:id/status
const updateCustomerStatus = asyncHandler(async (req, res) => {
  const customer = await Customer.findByIdAndUpdate(
    req.params.id,
    { status: req.body.status },
    { new: true, runValidators: true }
  );
  if (!customer) throw ApiError.notFound("Customer not found.");
  apiResponse.success(res, { message: "Customer status updated", data: customer });
});

// POST /api/v1/customers/:id/tags
const addTag = asyncHandler(async (req, res) => {
  const customer = await Customer.findByIdAndUpdate(
    req.params.id,
    { $addToSet: { tags: req.body.tag } },
    { new: true }
  );
  if (!customer) throw ApiError.notFound("Customer not found.");
  apiResponse.success(res, { message: "Tag added", data: customer });
});

// DELETE /api/v1/customers/:id/tags/:tag
const removeTag = asyncHandler(async (req, res) => {
  const customer = await Customer.findByIdAndUpdate(
    req.params.id,
    { $pull: { tags: req.params.tag } },
    { new: true }
  );
  if (!customer) throw ApiError.notFound("Customer not found.");
  apiResponse.success(res, { message: "Tag removed", data: customer });
});

// POST /api/v1/customers/:id/notes
const addNote = asyncHandler(async (req, res) => {
  const customer = await Customer.findByIdAndUpdate(
    req.params.id,
    { $push: { notes: { text: req.body.text, addedBy: req.user._id } } },
    { new: true }
  );
  if (!customer) throw ApiError.notFound("Customer not found.");
  apiResponse.success(res, { message: "Note added", data: customer });
});

// GET /api/v1/customers/:id/activity
const getCustomerActivity = asyncHandler(async (req, res) => {
  const customer = await Customer.findById(req.params.id).select("_id");
  if (!customer) throw ApiError.notFound("Customer not found.");

  const { page, limit, skip } = parsePagination(req.query);
  const [activities, total] = await Promise.all([
    Activity.find({ customer: customer._id })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("user", "name email"),
    Activity.countDocuments({ customer: customer._id }),
  ]);

  apiResponse.success(res, {
    message: "Customer activity fetched",
    data: activities,
    pagination: buildPaginationMeta({ page, limit, total }),
  });
});

// POST /api/v1/customers/import
//
// One import at a time per server process: a second upload while one is
// running gets 409 instead of racing it (no duplicate imports from a double
// click or a retry). The import itself is idempotent — re-uploading the same
// file counts existing mobiles as duplicates — so after a dropped connection
// the user can safely upload again.
let importInProgress = false;

const importCustomers = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest("Please upload an .xlsx, .xls or .csv file.");

  let columnMapping = {};
  if (req.body.columnMapping) {
    try {
      columnMapping = JSON.parse(req.body.columnMapping);
    } catch (err) {
      columnMapping = null;
    }
    if (!columnMapping || typeof columnMapping !== "object" || Array.isArray(columnMapping)) {
      await fs.unlink(req.file.path).catch(() => {});
      throw ApiError.badRequest("columnMapping must be a JSON object, e.g. {\"name\":\"Full Name\"}.");
    }
  }

  if (importInProgress) {
    await fs.unlink(req.file.path).catch(() => {});
    throw ApiError.conflict("Another customer import is already running. Please wait for it to finish.");
  }

  importInProgress = true;
  let summary;
  try {
    summary = await excelService.importCustomersFromFile(req.file.path, { columnMapping });
  } finally {
    importInProgress = false;
  }

  await recordAudit({
    user: req.user,
    action: "import",
    entity: "Customer",
    entityId: null,
    description:
      `Imported customers: ${summary.successCount} created, ${summary.duplicateCount} duplicates, ` +
      `${summary.invalidCount} invalid, ${summary.skippedCount} skipped (of ${summary.totalRows} rows) in ${summary.durationMs} ms.`,
  });

  apiResponse.success(res, { message: "Import completed", data: summary });
});

// GET /api/v1/customers/import/preview  (helper — inspect columns before mapping)
const previewImportFile = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest("Please upload a file to preview.");
  let preview;
  try {
    preview = excelService.readWorkbookPreview(req.file.path);
  } finally {
    await fs.unlink(req.file.path).catch(() => {});
  }
  apiResponse.success(res, { message: "File preview", data: preview });
});

// GET /api/v1/customers/export
const exportCustomers = asyncHandler(async (req, res) => {
  const filter = customerService.buildCustomerFilter(req.query);
  // Safety cap so an unfiltered export of a much larger future dataset
  // can't exhaust memory; paginate on the client for bigger exports.
  const customers = await Customer.find(filter).sort({ createdAt: -1 }).limit(20000).lean();

  const buffer = excelService.buildCustomerExportBuffer(customers);
  res.setHeader("Content-Disposition", "attachment; filename=customers-export.xlsx");
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buffer);
});

module.exports = {
  createCustomer,
  listCustomers,
  getCustomer,
  updateCustomer,
  deleteCustomer,
  updateCustomerStatus,
  addTag,
  removeTag,
  addNote,
  getCustomerActivity,
  importCustomers,
  previewImportFile,
  exportCustomers,
};
