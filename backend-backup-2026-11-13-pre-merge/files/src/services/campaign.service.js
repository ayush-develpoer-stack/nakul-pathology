const env = require("../config/env");
const logger = require("../utils/logger");
const ApiError = require("../utils/ApiError");
const Campaign = require("../models/Campaign");
const CampaignRecipient = require("../models/CampaignRecipient");
const Customer = require("../models/Customer");
const WhatsappTemplate = require("../models/WhatsappTemplate");
const { toIndianMobile, maskPhone } = require("../utils/whatsappAddress");
const { buildPaginationMeta } = require("../utils/pagination");
const { twilioErrorHint } = require("../utils/twilioErrorHints");
const twilioWhatsappService = require("./twilioWhatsapp.service");
const optOutService = require("./whatsappOptOut.service");

/**
 * WhatsApp campaigns: audience building, preview, start/cancel, progress.
 *
 * Nothing in this file sends a message. Starting a campaign only writes
 * CampaignRecipient rows ("queued"); the campaign worker
 * (campaignWorker.service.js) sends them, one at a time, within its limits.
 *
 * Eligibility (applied at preview, at start, and again just before each send):
 *   - valid Indian mobile number, deduplicated;
 *   - filter audiences: customers with marketingOptIn=true, status "active",
 *     consentStatus not "revoked";
 *   - list audiences: a listed number must belong to a CRM customer meeting
 *     the same conditions. Numbers that are not customers have no consent
 *     record and are excluded (an admin's general confirmation is not
 *     individual consent);
 *   - not on the WhatsApp opt-out list;
 *   - in WHATSAPP_TEST_ALLOWLIST while WHATSAPP_RESTRICT_TO_ALLOWLIST is on.
 */

// Above this many matching customers a filter audience is refused rather
// than loaded into memory.
const AUDIENCE_SCAN_LIMIT = 20000;
const SAMPLE_SIZE = 5;
const START_LOCK_STALE_MS = 5 * 60 * 1000;
const MAX_SCHEDULE_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;
const NAME_TOKEN = "{{name}}";

// ======================================================
// HELPERS
// ======================================================

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstName(name) {
  const first = String(name || "").trim().split(/\s+/)[0];
  return first ? first.slice(0, 50) : "Customer";
}

/** {"1": "{{name}}", "2": "Friday"} → {"1": "Asha", "2": "Friday"} */
function resolveVariables(contentVariables, displayName) {
  const resolved = {};
  for (const [key, value] of Object.entries(contentVariables || {})) {
    resolved[key] = value === NAME_TOKEN ? firstName(displayName) : String(value);
  }
  return resolved;
}

/** Template body with {{1}}, {{2}}… substituted, for the preview only. */
function renderBody(body, variables) {
  return String(body || "").replace(/\{\{\s*(\d{1,2})\s*\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : match
  );
}

/** Customer query from the whitelisted filter; eligibility conditions always win. */
function buildCustomerQuery(filter = {}) {
  const query = {};
  if (filter.city) query.city = new RegExp(`^${escapeRegex(filter.city)}$`, "i");
  if (filter.state) query.state = new RegExp(`^${escapeRegex(filter.state)}$`, "i");
  if (filter.gender) query.gender = filter.gender;
  if (filter.source) query.source = filter.source;
  if (Array.isArray(filter.tags) && filter.tags.length > 0) query.tags = { $in: filter.tags };
  query.marketingOptIn = true;
  query.status = "active";
  query.consentStatus = { $ne: "revoked" };
  return query;
}

function isEligibleCustomer(customer) {
  return customer.marketingOptIn === true && customer.status === "active" && customer.consentStatus !== "revoked";
}

// ======================================================
// TEMPLATE CHECKS
// ======================================================

/** Issues preventing `template` + `contentVariables` from being sent via Twilio. */
function templateIssues(template, contentVariables = {}) {
  if (!template) {
    return [{ code: "template_missing", message: "Select an approved WhatsApp template. Campaigns must use an approved template." }];
  }
  const issues = [];
  if (template.status !== "approved") {
    issues.push({
      code: "template_not_approved",
      message: `Template "${template.name}" is "${template.status}". Only templates approved by WhatsApp can be used for campaigns.`,
    });
  }
  if (!template.twilioContentSid) {
    issues.push({
      code: "template_no_content_sid",
      message: `Template "${template.name}" has no Twilio Content SID (HX…). Add the SID of the matching approved template from Twilio Console → Content Template Builder.`,
    });
  } else if (!twilioWhatsappService.SID_PATTERNS.content.test(template.twilioContentSid)) {
    issues.push({
      code: "template_invalid_content_sid",
      message: `Template "${template.name}" has an invalid Twilio Content SID. It must be HX followed by 32 hex characters, copied from Twilio Console → Content Template Builder.`,
    });
  }
  const required = (template.variables || []).map((v) => String(v.position));
  const placeholders = [...new Set([...String(template.body || "").matchAll(/\{\{\s*(\d{1,2})\s*\}\}/g)].map((m) => m[1]))];
  if (placeholders.length !== required.length || placeholders.some((key) => !required.includes(key))) {
    issues.push({
      code: "template_variables_mismatch",
      message: `Template "${template.name}" declares variable(s) ${required.map((k) => `{{${k}}}`).join(", ") || "none"} but its body uses ${
        placeholders.map((k) => `{{${k}}}`).join(", ") || "none"
      }. Fix the template on the WhatsApp Templates page so they match the Twilio Content template.`,
    });
  }
  const provided = Object.keys(contentVariables || {});
  const missing = required.filter((key) => !provided.includes(key));
  const unknown = provided.filter((key) => !required.includes(key));
  if (missing.length) {
    issues.push({ code: "variables_missing", message: `Provide a value for template variable(s) ${missing.map((k) => `{{${k}}}`).join(", ")}.` });
  }
  if (unknown.length) {
    issues.push({ code: "variables_unknown", message: `The template has no variable(s) ${unknown.map((k) => `{{${k}}}`).join(", ")}.` });
  }
  return issues;
}

async function loadTemplate(templateId) {
  if (!templateId) return null;
  return WhatsappTemplate.findById(templateId)
    .select("name status body variables twilioContentSid category language")
    .lean();
}

/** Readiness for campaign delivery: provider-specific, never falls back. */
function deliveryIssues(campaignProvider) {
  const issues = [];
  if (campaignProvider !== "twilio") {
    issues.push({
      code: "provider_unsupported",
      message: "Only Twilio campaign delivery is implemented. Meta campaigns cannot be started.",
    });
  }
  const readiness = twilioWhatsappService.getSendReadiness();
  issues.push(...readiness.issues);
  if (!env.WHATSAPP_CAMPAIGNS_ENABLED) {
    issues.push({
      code: "campaigns_disabled",
      message: "The campaign worker is switched off on the server (WHATSAPP_CAMPAIGNS_ENABLED is not true).",
    });
  }
  return { readiness, issues };
}

// ======================================================
// AUDIENCE
// ======================================================

/**
 * Computes who would receive the campaign right now.
 * @returns {Promise<{ recipients: Array<{ phoneNumber, customer, displayName }>, stats: object, tooLarge: boolean }>}
 */
async function computeAudience({ audienceType = "filter", audienceFilter = {}, recipientList = [] }) {
  const stats = {
    candidates: 0,
    invalid: 0,
    duplicates: 0,
    notOptedIn: 0,
    external: 0,
    optedOut: 0,
    notAllowlisted: 0,
    eligible: 0,
  };
  const seen = new Set();
  let candidates = [];

  if (audienceType === "list") {
    stats.candidates = recipientList.length;
    const normalized = [];
    for (const raw of recipientList) {
      const phoneNumber = toIndianMobile(raw);
      if (!phoneNumber) stats.invalid += 1;
      else if (seen.has(phoneNumber)) stats.duplicates += 1;
      else {
        seen.add(phoneNumber);
        normalized.push(phoneNumber);
      }
    }

    const byPhone = new Map();
    for (let i = 0; i < normalized.length; i += 1000) {
      const chunk = normalized.slice(i, i + 1000);
      // eslint-disable-next-line no-await-in-loop
      const customers = await Customer.find({ $or: [{ mobile: { $in: chunk } }, { whatsappNumber: { $in: chunk } }] })
        .select("_id name mobile whatsappNumber marketingOptIn status consentStatus")
        .lean();
      for (const customer of customers) {
        [customer.whatsappNumber, customer.mobile].forEach((n) => {
          const phone = toIndianMobile(n);
          if (phone && !byPhone.has(phone)) byPhone.set(phone, customer);
        });
      }
    }

    for (const phoneNumber of normalized) {
      const customer = byPhone.get(phoneNumber);
      if (customer && !isEligibleCustomer(customer)) {
        stats.notOptedIn += 1;
        continue;
      }
      if (!customer) {
        stats.external += 1;
        continue;
      }
      candidates.push({ phoneNumber, customer: customer._id, displayName: customer.name || "" });
    }
  } else {
    const query = buildCustomerQuery(audienceFilter);
    stats.candidates = await Customer.countDocuments(query);
    if (stats.candidates > AUDIENCE_SCAN_LIMIT) {
      return { recipients: [], stats, tooLarge: true };
    }
    const customers = await Customer.find(query).select("_id name mobile whatsappNumber").sort({ _id: 1 }).lean();
    for (const customer of customers) {
      const phoneNumber = toIndianMobile(customer.whatsappNumber) || toIndianMobile(customer.mobile);
      if (!phoneNumber) stats.invalid += 1;
      else if (seen.has(phoneNumber)) stats.duplicates += 1;
      else {
        seen.add(phoneNumber);
        candidates.push({ phoneNumber, customer: customer._id, displayName: customer.name || "" });
      }
    }
  }

  const optedOut = await optOutService.findOptedOut(candidates.map((c) => c.phoneNumber));
  candidates = candidates.filter((c) => {
    if (optedOut.has(c.phoneNumber)) {
      stats.optedOut += 1;
      return false;
    }
    return true;
  });

  if (env.WHATSAPP_RESTRICT_TO_ALLOWLIST) {
    candidates = candidates.filter((c) => {
      if (!twilioWhatsappService.isAllowlisted(c.phoneNumber)) {
        stats.notAllowlisted += 1;
        return false;
      }
      return true;
    });
  }

  stats.eligible = candidates.length;
  return { recipients: candidates, stats, tooLarge: false };
}

// ======================================================
// PREVIEW (dry run — sends nothing, writes nothing)
// ======================================================

/**
 * @param {object} campaignLike - a saved Campaign or validated draft data (templateId or template)
 */
async function previewCampaign(campaignLike) {
  const templateId = campaignLike.templateId !== undefined ? campaignLike.templateId : campaignLike.template;
  const provider = campaignLike.provider || "twilio";
  const contentVariables = campaignLike.contentVariables || {};

  const [template, audience] = await Promise.all([
    loadTemplate(templateId),
    computeAudience({
      audienceType: campaignLike.audienceType,
      audienceFilter: campaignLike.audienceFilter,
      recipientList: campaignLike.recipientList,
    }),
  ]);

  const issues = [...templateIssues(template, contentVariables)];
  if (audience.tooLarge) {
    issues.push({
      code: "audience_too_large",
      message: `More than ${AUDIENCE_SCAN_LIMIT} customers match. Narrow the audience filters.`,
    });
  } else if (audience.stats.eligible === 0) {
    issues.push({ code: "audience_empty", message: "No eligible recipients. Check the filters, opt-ins and opt-outs." });
  } else if (audience.stats.eligible > env.WHATSAPP_CAMPAIGN_MAX_RECIPIENTS) {
    issues.push({
      code: "audience_over_limit",
      message: `${audience.stats.eligible} eligible recipients exceeds the per-campaign limit of ${env.WHATSAPP_CAMPAIGN_MAX_RECIPIENTS} (WHATSAPP_CAMPAIGN_MAX_RECIPIENTS).`,
    });
  }
  const delivery = deliveryIssues(provider);

  const sampleRecipient = audience.recipients[0];
  const sampleVariables = resolveVariables(contentVariables, sampleRecipient ? sampleRecipient.displayName : "");
  const eligible = audience.stats.eligible;

  return {
    provider,
    audience: { ...audience.stats, tooLarge: audience.tooLarge },
    sample: audience.recipients.slice(0, SAMPLE_SIZE).map((r) => ({
      phone: maskPhone(r.phoneNumber),
      isCustomer: Boolean(r.customer),
    })),
    template: template
      ? {
          id: String(template._id),
          name: template.name,
          status: template.status,
          category: template.category,
          hasContentSid: Boolean(template.twilioContentSid),
          variables: (template.variables || []).map((v) => ({ position: v.position, name: v.name })),
          renderedBody: renderBody(template.body, sampleVariables),
        }
      : null,
    // Content problems must be fixed before saving/starting; delivery
    // problems are server configuration and are reported separately.
    issues,
    deliveryIssues: delivery.issues,
    sandbox: delivery.readiness.sandbox,
    restrictToAllowlist: env.WHATSAPP_RESTRICT_TO_ALLOWLIST,
    limits: {
      maxRecipients: env.WHATSAPP_CAMPAIGN_MAX_RECIPIENTS,
      maxPerMinute: env.WHATSAPP_CAMPAIGN_MAX_PER_MINUTE,
    },
    estimatedMinutes: eligible ? Math.ceil(eligible / env.WHATSAPP_CAMPAIGN_MAX_PER_MINUTE) : 0,
    canStart: issues.length === 0 && delivery.issues.length === 0,
  };
}

// ======================================================
// PROGRESS
// ======================================================

async function getProgress(campaignId) {
  const rows = await CampaignRecipient.aggregate([
    { $match: { campaign: toObjectId(campaignId) } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  const counts = Object.fromEntries(CampaignRecipient.RECIPIENT_STATUSES.map((s) => [s, 0]));
  let total = 0;
  for (const row of rows) {
    if (row._id in counts) counts[row._id] = row.count;
    total += row.count;
  }
  const remaining = counts.queued + counts.processing;
  return {
    total,
    counts,
    remaining,
    percentComplete: total === 0 ? 0 : Math.round(((total - remaining) / total) * 100),
  };
}

function toObjectId(id) {
  // eslint-disable-next-line global-require
  const { Types } = require("mongoose");
  return id instanceof Types.ObjectId ? id : new Types.ObjectId(String(id));
}

/** Refreshes the denormalized counters on the Campaign from its recipient rows. */
async function syncCampaignCounters(campaignId) {
  const { counts } = await getProgress(campaignId);
  await Campaign.updateOne(
    { _id: campaignId },
    {
      $set: {
        queued: counts.queued,
        processing: counts.processing,
        accepted: counts.accepted,
        sent: counts.sent + counts.delivered + counts.read,
        delivered: counts.delivered + counts.read,
        read: counts.read,
        failed: counts.failed,
        unknown: counts.unknown,
        skipped: counts.skipped,
        cancelledRecipients: counts.cancelled,
      },
    }
  );
  return counts;
}

// Message.status (after a provider callback) → CampaignRecipient.status.
const MESSAGE_TO_RECIPIENT_STATUS = {
  queued: "accepted",
  sent: "sent",
  delivered: "delivered",
  read: "read",
  failed: "failed",
};
const RECIPIENT_RANK = { accepted: 1, sent: 2, delivered: 3, read: 4 };

function recipientAllowedPrevious(target) {
  if (target === "failed") return ["accepted", "sent"];
  if (!(target in RECIPIENT_RANK)) return [];
  return Object.keys(RECIPIENT_RANK).filter((s) => RECIPIENT_RANK[s] < RECIPIENT_RANK[target]);
}

/**
 * Mirrors a campaign message's provider status onto its recipient row
 * (forward-only, like Message itself), then refreshes the counters.
 * Safe to call for any message; non-campaign messages are ignored.
 */
async function applyMessageStatusToRecipient(message) {
  if (!message || !message.campaign || !message.messageId) return false;
  const target = MESSAGE_TO_RECIPIENT_STATUS[message.status];
  if (!target) return false;
  const updated = await CampaignRecipient.findOneAndUpdate(
    { campaign: message.campaign, messageId: message.messageId, status: { $in: recipientAllowedPrevious(target) } },
    {
      $set: {
        status: target,
        ...(target === "failed"
          ? { errorCode: String(message.errorCode || ""), errorMessage: String(message.errorMessage || "").slice(0, 300) }
          : {}),
      },
    },
    { new: true }
  );
  if (!updated) return false;
  await syncCampaignCounters(message.campaign);
  return true;
}

// ======================================================
// CRUD
// ======================================================

function draftFields(data) {
  const fields = {};
  ["name", "description", "contentVariables", "audienceType", "audienceFilter", "recipientList"].forEach((key) => {
    if (data[key] !== undefined) fields[key] = data[key];
  });
  if (data.templateId !== undefined) fields.template = data.templateId || null;
  if (data.templateName !== undefined) fields.templateName = data.templateName;
  return fields;
}

async function applyTemplateLabel(fields) {
  if (fields.template) {
    const template = await loadTemplate(fields.template);
    if (!template) throw ApiError.badRequest("Validation failed", [{ field: "templateId", message: "Template not found." }]);
    fields.templateName = template.name;
  }
  return fields;
}

async function refreshDraftEstimate(campaign) {
  try {
    const audience = await computeAudience(campaign);
    campaign.totalRecipients = audience.stats.eligible;
    campaign.audienceStats = { ...audience.stats, tooLarge: audience.tooLarge, computedAt: new Date() };
  } catch (err) {
    logger.warn(`Campaign ${campaign._id}: audience estimate failed: ${err.message}`);
  }
}

async function createCampaign(data, user) {
  const fields = await applyTemplateLabel(draftFields(data));
  const campaign = new Campaign({ ...fields, provider: "twilio", status: "draft", createdBy: user._id });
  await refreshDraftEstimate(campaign);
  await campaign.save();
  return campaign;
}

async function updateCampaign(id, data) {
  const campaign = await Campaign.findById(id);
  if (!campaign) throw ApiError.notFound("Campaign not found.");
  if (campaign.status !== "draft") throw ApiError.badRequest("Only draft campaigns can be edited.");
  const fields = await applyTemplateLabel(draftFields(data));
  Object.assign(campaign, fields);
  await refreshDraftEstimate(campaign);
  await campaign.save();
  return campaign;
}

const DELETABLE_STATUSES = ["draft", "completed", "cancelled", "failed"];

async function deleteCampaign(id) {
  const campaign = await Campaign.findById(id);
  if (!campaign) throw ApiError.notFound("Campaign not found.");
  if (!DELETABLE_STATUSES.includes(campaign.status)) {
    throw ApiError.badRequest("Cancel the campaign before deleting it.");
  }
  await CampaignRecipient.deleteMany({ campaign: campaign._id });
  await campaign.deleteOne();
  return campaign;
}

async function listCampaigns({ page, limit, status, search }) {
  const filter = {};
  if (status) filter.status = status;
  if (search) filter.name = new RegExp(escapeRegex(search), "i");
  const [items, total] = await Promise.all([
    Campaign.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select("-recipientList")
      .populate("createdBy", "name email"),
    Campaign.countDocuments(filter),
  ]);
  return { items, pagination: buildPaginationMeta({ page, limit, total }) };
}

async function getCampaign(id) {
  const campaign = await Campaign.findById(id)
    .populate("createdBy", "name email")
    .populate("template", "name status category language twilioContentSid variables");
  if (!campaign) throw ApiError.notFound("Campaign not found.");
  const progress = await getProgress(campaign._id);
  const json = campaign.toJSON();
  // Populated template → safe summary (never the Content SID itself).
  if (json.template && json.template.name !== undefined) {
    json.template = {
      _id: json.template._id,
      name: json.template.name,
      status: json.template.status,
      category: json.template.category,
      language: json.template.language,
      hasContentSid: Boolean(json.template.twilioContentSid),
      variables: (json.template.variables || []).map((v) => ({ position: v.position, name: v.name })),
    };
  }
  delete json.contentSid;
  return { ...json, progress };
}

// ======================================================
// START / CANCEL
// ======================================================

async function insertRecipients(campaignId, recipients) {
  for (let i = 0; i < recipients.length; i += 500) {
    const docs = recipients.slice(i, i + 500).map((r) => ({
      campaign: campaignId,
      customer: r.customer,
      phoneNumber: r.phoneNumber,
      displayName: String(r.displayName || "").slice(0, 100),
      status: "queued",
      nextAttemptAt: null,
    }));
    try {
      // eslint-disable-next-line no-await-in-loop
      await CampaignRecipient.insertMany(docs, { ordered: false });
    } catch (err) {
      // A retried start re-inserts rows that already exist: ignore only those.
      const writeErrors = (err && err.writeErrors) || [];
      const onlyDuplicates =
        (writeErrors.length > 0 && writeErrors.every((e) => e.code === 11000)) ||
        (writeErrors.length === 0 && err && err.code === 11000);
      if (!onlyDuplicates) throw err;
    }
  }
}

/**
 * Starts (or schedules) a draft campaign after re-running the preview.
 * Materializes recipient rows only; the worker does the sending.
 */
async function startCampaign(id, { confirmRecipientCount, scheduledAt }, user) {
  const campaign = await Campaign.findById(id);
  if (!campaign) throw ApiError.notFound("Campaign not found.");
  if (campaign.status !== "draft") throw ApiError.conflict("Only draft campaigns can be started.");

  let scheduleDate = null;
  if (scheduledAt) {
    scheduleDate = new Date(scheduledAt);
    const ahead = scheduleDate.getTime() - Date.now();
    if (ahead > MAX_SCHEDULE_AHEAD_MS) {
      throw ApiError.badRequest("Validation failed", [{ field: "scheduledAt", message: "Schedule at most 30 days ahead." }]);
    }
    if (ahead <= 0) scheduleDate = null; // past/now → start immediately
  }

  const preview = await previewCampaign(campaign);
  const blocking = [...preview.issues, ...preview.deliveryIssues];
  if (blocking.length > 0) {
    throw ApiError.badRequest(
      "This campaign cannot start yet.",
      blocking.map((issue) => ({ field: issue.code, message: issue.message }))
    );
  }
  if (confirmRecipientCount !== preview.audience.eligible) {
    throw ApiError.conflict(
      `The eligible audience is now ${preview.audience.eligible} (you confirmed ${confirmRecipientCount}). Review the preview and confirm again.`
    );
  }
  // Confirm with Twilio that WhatsApp approved the template (the CRM flag is
  // set by hand). Read-only; only reached once sending is enabled.
  const template = await loadTemplate(campaign.template);
  const approvalIssue = await twilioWhatsappService.templateApprovalIssue(template.twilioContentSid);
  if (approvalIssue) {
    throw ApiError.badRequest("This campaign cannot start yet.", [{ field: approvalIssue.code, message: approvalIssue.message }]);
  }

  const now = new Date();
  const locked = await Campaign.findOneAndUpdate(
    {
      _id: campaign._id,
      status: "draft",
      $or: [{ startLockedAt: null }, { startLockedAt: { $lt: new Date(now.getTime() - START_LOCK_STALE_MS) } }],
    },
    { $set: { startLockedAt: now } },
    { new: true }
  );
  if (!locked) throw ApiError.conflict("This campaign is already being started.");

  try {
    const audience = await computeAudience(campaign);
    if (audience.stats.eligible !== confirmRecipientCount) {
      throw ApiError.conflict("The eligible audience changed while starting. Review the preview and confirm again.");
    }
    await insertRecipients(campaign._id, audience.recipients);
    await Campaign.updateOne(
      { _id: campaign._id, startLockedAt: now },
      {
        $set: {
          status: scheduleDate ? "scheduled" : "in_progress",
          scheduledAt: scheduleDate,
          startedAt: scheduleDate ? null : now,
          startedBy: user._id,
          contentSid: template.twilioContentSid,
          templateName: template.name,
          recipientsMaterializedAt: new Date(),
          totalRecipients: audience.stats.eligible,
          queued: audience.stats.eligible,
          audienceStats: { ...audience.stats, computedAt: now },
          startLockedAt: null,
          lastError: "",
        },
      }
    );
  } catch (err) {
    await Campaign.updateOne({ _id: campaign._id, startLockedAt: now }, { $set: { startLockedAt: null } });
    // Rows written before the failure are removed so the draft stays clean.
    await CampaignRecipient.deleteMany({ campaign: campaign._id, status: "queued" }).catch(() => {});
    throw err;
  }

  return getCampaign(campaign._id);
}

async function cancelCampaign(id, user) {
  const now = new Date();
  const campaign = await Campaign.findOneAndUpdate(
    { _id: id, status: { $in: ["scheduled", "in_progress"] } },
    { $set: { status: "cancelled", cancelledAt: now, cancelledBy: user._id } },
    { new: true }
  );
  if (!campaign) {
    const exists = await Campaign.exists({ _id: id });
    if (!exists) throw ApiError.notFound("Campaign not found.");
    throw ApiError.conflict("Only scheduled or running campaigns can be cancelled.");
  }
  // Rows already claimed by the worker finish (or are cancelled by it just
  // before sending); everything still waiting is cancelled now.
  await CampaignRecipient.updateMany(
    { campaign: campaign._id, status: "queued" },
    { $set: { status: "cancelled", processedAt: now } }
  );
  await syncCampaignCounters(campaign._id);
  return getCampaign(campaign._id);
}

// ======================================================
// RECIPIENTS (read-only, masked)
// ======================================================

async function listRecipients(campaignId, { page, limit, status }) {
  const exists = await Campaign.exists({ _id: campaignId });
  if (!exists) throw ApiError.notFound("Campaign not found.");
  const filter = { campaign: campaignId, ...(status ? { status } : {}) };
  const [rows, total] = await Promise.all([
    CampaignRecipient.find(filter)
      .sort({ createdAt: 1, _id: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select("customer phoneNumber status skipReason attempts errorCode errorMessage processedAt updatedAt")
      .lean(),
    CampaignRecipient.countDocuments(filter),
  ]);
  return {
    items: rows.map((r) => ({
      id: String(r._id),
      phone: maskPhone(r.phoneNumber),
      customerId: r.customer ? String(r.customer) : null,
      status: r.status,
      skipReason: r.skipReason || null,
      attempts: r.attempts || 0,
      errorCode: r.errorCode || null,
      errorMessage: r.errorMessage || null,
      // Campaign delivery is Twilio only.
      errorHint: twilioErrorHint(r.errorCode),
      processedAt: r.processedAt ? new Date(r.processedAt).toISOString() : null,
      updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
    })),
    pagination: buildPaginationMeta({ page, limit, total }),
  };
}

module.exports = {
  NAME_TOKEN,
  AUDIENCE_SCAN_LIMIT,
  resolveVariables,
  renderBody,
  buildCustomerQuery,
  isEligibleCustomer,
  templateIssues,
  computeAudience,
  previewCampaign,
  getProgress,
  syncCampaignCounters,
  applyMessageStatusToRecipient,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  listCampaigns,
  getCampaign,
  startCampaign,
  cancelCampaign,
  listRecipients,
};
