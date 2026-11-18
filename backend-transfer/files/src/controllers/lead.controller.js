const Lead = require("../models/Lead");
const FollowUp = require("../models/FollowUp");

const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");
const apiResponse = require("../utils/apiResponse");

const {
  parsePagination,
  buildPaginationMeta,
} = require("../utils/pagination");

const generateId = require("../utils/generateId");
const {
  normalizePhone,
} = require("../utils/normalizePhone");

const {
  recordAudit,
} = require("../utils/auditLog");
const { searchRegex } = require("../utils/escapeRegex");

// Numeric mirror of Lead.priority so "sort by priority" means urgency
// (low < medium < high < urgent), not alphabetical order. 0 = not set.
const PRIORITY_RANK = { low: 1, medium: 2, high: 3, urgent: 4 };
const priorityRankOf = (priority) => PRIORITY_RANK[priority] || 0;

// Marks the follow-up that a lead's nextFollowUpDate creates. Only THIS one is
// replaced when the lead's date changes; follow-ups scheduled manually
// (Follow-ups page / lead details) are never deleted by a lead edit.
const AUTO_FOLLOWUP_DESCRIPTION = "Follow-up scheduled from lead";

const sameInstant = (a, b) => {
  const ta = a ? new Date(a).getTime() : null;
  const tb = b ? new Date(b).getTime() : null;
  return ta === tb || (Number.isNaN(ta) && Number.isNaN(tb));
};

// ======================================================
// CREATE LEAD
// POST /api/v1/leads
// ======================================================

const createLead = asyncHandler(
  async (req, res) => {
    const body = req.body || {};

    // --------------------------------------------------
    // Create Lead
    // --------------------------------------------------

    const lead =
      await Lead.create({
        name: body.name,

        mobile:
          normalizePhone(body.mobile),

        email:
          body.email || "",

        requirement:
          body.requirement || "",

        test:
          body.test || "",

        source:
          body.source || "other",

        status:
          body.status || "new",

        priority:
          body.priority || null,
        priorityRank:
          priorityRankOf(body.priority),
        nextFollowUpDate:
          body.nextFollowUpDate || null,

        notes:
          body.notes || "",

        assignedTo:
          body.assignedTo || null,

        customer:
          body.customer || null,

        leadId:
          generateId("LEAD"),
      });

    // --------------------------------------------------
    // Automatically create Follow-up
    // --------------------------------------------------

    if (body.nextFollowUpDate) {
      await FollowUp.create({
        lead: lead._id,

        type: "call",

        date: new Date(
          body.nextFollowUpDate
        ),

        time: "",

        description:
          AUTO_FOLLOWUP_DESCRIPTION,

        assignedTo:
          body.assignedTo || null,

        status: "pending",
      });
    }

    // --------------------------------------------------
    // Audit
    // --------------------------------------------------

    await recordAudit({
      user: req.user,

      action: "create",

      entity: "Lead",

      entityId: lead.leadId,

      description:
        `Created lead ${lead.name} (${lead.leadId})`,
    });

    // --------------------------------------------------
    // Response
    // --------------------------------------------------

    apiResponse.created(
      res,
      "Lead created successfully",
      lead
    );
  }
);

// ======================================================
// LIST LEADS
// GET /api/v1/leads
// ======================================================

const listLeads = asyncHandler(
  async (req, res) => {
    const {
      page,
      limit,
      skip,
    } =
      parsePagination(req.query);

    const filter = {};

    // --------------------------------------------------
    // Status
    // --------------------------------------------------

    if (req.query.status) {
      filter.status =
        req.query.status;
    }

    // --------------------------------------------------
    // Source
    // --------------------------------------------------

    if (req.query.source) {
      filter.source =
        req.query.source;
    }

    if (
      req.query.priority &&
      req.query.priority !== "all"
    ) {
      filter.priority =
        req.query.priority;
    }

    // --------------------------------------------------
    // Priority
    //
    // NOTE:
    // Current Lead model does not have priority.
    // So this filter is intentionally ignored.
    // --------------------------------------------------

    // --------------------------------------------------
    // Assigned To
    // --------------------------------------------------

    if (req.query.assignedTo) {
      filter.assignedTo =
        req.query.assignedTo;
    }

    // --------------------------------------------------
    // Search
    // --------------------------------------------------

    if (req.query.search) {
      const regex =
        searchRegex(
          req.query.search
        );

      filter.$or = [
        {
          name: regex,
        },
        {
          mobile: regex,
        },
        {
          email: regex,
        },
        {
          leadId: regex,
        },
      ];
    }

    // --------------------------------------------------
    // Sort (sortBy is whitelisted by listLeadQuerySchema)
    // --------------------------------------------------

    const sortField =
      req.query.sortBy === "priority"
        ? "priorityRank"
        : req.query.sortBy || "createdAt";
    const sortDirection =
      req.query.sortOrder === "asc" ? 1 : -1;
    const sort = { [sortField]: sortDirection };
    // Stable tie-break: newest first.
    if (sortField !== "createdAt") sort.createdAt = -1;

    // --------------------------------------------------
    // Fetch
    // --------------------------------------------------

    const [
      leads,
      total,
    ] =
      await Promise.all([
        Lead.find(filter)
          .sort(sort)
          .skip(skip)
          .limit(limit)

          .populate(
            "assignedTo",
            "name email"
          )

          .populate(
            "customer",
            "customerId name"
          ),

        Lead.countDocuments(
          filter
        ),
      ]);

    // --------------------------------------------------
    // Response
    // --------------------------------------------------

    apiResponse.success(res, {
      message:
        "Leads fetched",

      data: leads,

      pagination:
        buildPaginationMeta({
          page,
          limit,
          total,
        }),
    });
  }
);

// ======================================================
// GET SINGLE LEAD
// GET /api/v1/leads/:id
// ======================================================

const getLead = asyncHandler(
  async (req, res) => {
    const lead =
      await Lead.findById(
        req.params.id
      )
        .populate(
          "assignedTo",
          "name email"
        )
        .populate(
          "customer",
          "customerId name"
        );

    if (!lead) {
      throw ApiError.notFound(
        "Lead not found."
      );
    }

    apiResponse.success(res, {
      message:
        "Lead fetched",

      data: lead,
    });
  }
);

// ======================================================
// UPDATE LEAD
// PATCH /api/v1/leads/:id
// ======================================================

const updateLead = asyncHandler(
  async (req, res) => {
    const updates = {
      ...req.body,
    };

    // --------------------------------------------------
    // Normalize mobile
    // --------------------------------------------------

    if (updates.mobile) {
      updates.mobile =
        normalizePhone(
          updates.mobile
        );
    }

    // --------------------------------------------------
    // Empty follow-up date
    // --------------------------------------------------

    if (
      Object.prototype.hasOwnProperty.call(
        updates,
        "nextFollowUpDate"
      ) &&
      updates.nextFollowUpDate === ""
    ) {
      updates.nextFollowUpDate =
        null;
    }

    // --------------------------------------------------
    // Empty assigned user
    // --------------------------------------------------

    if (
      Object.prototype.hasOwnProperty.call(
        updates,
        "priority"
      )
    ) {
      updates.priority =
        updates.priority || null;
      updates.priorityRank =
        priorityRankOf(updates.priority);
    }

    if (
      updates.assignedTo === ""
    ) {
      updates.assignedTo =
        null;
    }

    // --------------------------------------------------
    // Find Lead
    // --------------------------------------------------

    const existingLead =
      await Lead.findById(
        req.params.id
      );

    if (!existingLead) {
      throw ApiError.notFound(
        "Lead not found."
      );
    }

    // --------------------------------------------------
    // Update Lead
    // --------------------------------------------------

    const lead =
      await Lead.findByIdAndUpdate(
        req.params.id,

        updates,

        {
          new: true,
          runValidators: true,
        }
      )
        .populate(
          "assignedTo",
          "name email"
        )
        .populate(
          "customer",
          "customerId name"
        );

    // --------------------------------------------------
    // Sync Follow-up
    // --------------------------------------------------

    if (
      Object.prototype.hasOwnProperty.call(
        updates,
        "nextFollowUpDate"
      ) &&
      // Re-sending the unchanged date (e.g. a full-form save) is a no-op.
      !sameInstant(updates.nextFollowUpDate, existingLead.nextFollowUpDate)
    ) {
      // Replace only the lead's auto-created pending follow-up.
      await FollowUp.deleteMany({
        lead: lead._id,
        status: "pending",
        description: AUTO_FOLLOWUP_DESCRIPTION,
      });

      // Create new pending follow-up
      if (
        updates.nextFollowUpDate
      ) {
        await FollowUp.create({
          lead: lead._id,

          type: "call",

          date: new Date(
            updates.nextFollowUpDate
          ),

          time: "",

          description:
            AUTO_FOLLOWUP_DESCRIPTION,

          assignedTo:
            lead.assignedTo?._id ||
            lead.assignedTo ||
            null,

          status: "pending",
        });
      }
    }

    // --------------------------------------------------
    // Audit
    // --------------------------------------------------

    await recordAudit({
      user: req.user,

      action: "update",

      entity: "Lead",

      entityId:
        lead.leadId,

      description:
        `Updated lead ${lead.name} (${lead.leadId})`,
    });

    // --------------------------------------------------
    // Response
    // --------------------------------------------------

    apiResponse.success(res, {
      message:
        "Lead updated",

      data: lead,
    });
  }
);

// ======================================================
// DELETE LEAD
// DELETE /api/v1/leads/:id
// ======================================================

const deleteLead = asyncHandler(
  async (req, res) => {
    const lead =
      await Lead.findByIdAndDelete(
        req.params.id
      );

    if (!lead) {
      throw ApiError.notFound(
        "Lead not found."
      );
    }

    // --------------------------------------------------
    // Delete related follow-ups
    // --------------------------------------------------

    await FollowUp.deleteMany({
      lead: lead._id,
    });

    // --------------------------------------------------
    // Audit
    // --------------------------------------------------

    await recordAudit({
      user: req.user,

      action: "delete",

      entity: "Lead",

      entityId:
        lead.leadId,

      description:
        `Deleted lead ${lead.name} (${lead.leadId})`,
    });

    apiResponse.success(res, {
      message:
        "Lead deleted",
    });
  }
);

module.exports = {
  createLead,
  listLeads,
  getLead,
  updateLead,
  deleteLead,
};