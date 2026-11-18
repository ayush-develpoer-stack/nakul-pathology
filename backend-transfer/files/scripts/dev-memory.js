/**
 * `npm run dev:memory` — run the API locally against a THROWAWAY in-memory
 * MongoDB with synthetic data. Safe even when backend/.env points at
 * production: every variable the app reads is set here first, and dotenv
 * never overrides a variable that is already set (even to "").
 *
 *  - MongoDB: mongodb-memory-server-core on 127.0.0.1, deleted on exit.
 *  - WhatsApp sending and campaigns: forced OFF; no Meta/Twilio/MSG91 keys.
 *  - Cloudinary: not configured (uploads return a clear error).
 *  - Seeds synthetic users and records only (no real patient data).
 *
 * Options (env): DEV_PORT (5055), DEV_CLIENT_URL (http://localhost:4180),
 *   DEV_RATE_LIMIT_MAX (API requests per 15 min per IP; default = production default 300).
 * Dev-only logins (in-memory DB only):
 *   admin@dev.local / DevAdmin#2026     staff@dev.local / DevStaff#2026
 */
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { MongoMemoryServer } = require("mongodb-memory-server-core");

const PORT = Number(process.env.DEV_PORT || 5055);
const CLIENT_URL = process.env.DEV_CLIENT_URL || "http://localhost:4180";

async function main() {
  const mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 60000 } });
  const uri = mongod.getUri("nakul_crm_dev");
  assert.ok(["127.0.0.1", "localhost"].includes(new URL(uri).hostname), "refusing a non-loopback database");

  const blank = (keys) => Object.fromEntries(keys.map((k) => [k, ""]));
  Object.assign(process.env, {
    ...blank([
      "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET", "CLOUDINARY_CLOUD_NAME", "CRM_URL", "RENDER_GIT_COMMIT",
      "META_WHATSAPP_ACCESS_TOKEN", "META_WHATSAPP_BUSINESS_ACCOUNT_ID", "META_WHATSAPP_PHONE_NUMBER_ID", "META_WHATSAPP_VERIFY_TOKEN",
      "MSG91_AUTH_KEY", "MSG91_WEBHOOK_SECRET", "MSG91_WHATSAPP_NUMBER",
      "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_MESSAGING_SERVICE_SID", "TWILIO_STATUS_CALLBACK_URL",
      "TWILIO_TEST_CONTENT_SID", "TWILIO_WEBHOOK_URL", "TWILIO_WHATSAPP_FROM", "TWILIO_WHATSAPP_SANDBOX",
      "WHATSAPP_PROVIDER", "WHATSAPP_TEST_ALLOWLIST", "WHATSAPP_RESTRICT_TO_ALLOWLIST",
      "WHATSAPP_CAMPAIGN_MAX_PER_MINUTE", "WHATSAPP_CAMPAIGN_MAX_RECIPIENTS",
      "SEED_ADMIN_EMAIL", "SEED_ADMIN_NAME", "SEED_ADMIN_PASSWORD", "SEED_ADMIN_PHONE",
      "PUBLIC_RATE_LIMIT_MAX_REQUESTS", "RATE_LIMIT_WINDOW_MINUTES", "JWT_EXPIRES_IN",
    ]),
    NODE_ENV: "development",
    PORT: String(PORT),
    CLIENT_URL,
    MONGODB_URI: uri,
    JWT_SECRET: crypto.randomBytes(32).toString("hex"),
    COOKIE_SECRET: crypto.randomBytes(32).toString("hex"),
    WHATSAPP_SENDING_ENABLED: "false",
    WHATSAPP_CAMPAIGNS_ENABLED: "false",
    // Production default (300 per 15 min per IP) unless overridden for heavy local testing.
    RATE_LIMIT_MAX_REQUESTS: process.env.DEV_RATE_LIMIT_MAX || "",
  });

  const env = require("../src/config/env");
  assert.equal(env.MONGODB_URI, uri, "MONGODB_URI must be the in-memory server");
  assert.equal(env.WHATSAPP_SENDING_ENABLED, false);
  assert.equal(env.WHATSAPP_CAMPAIGNS_ENABLED, false);

  const { connectDB } = require("../src/config/db");
  await connectDB();
  await seed();

  const app = require("../src/app");
  const server = app.listen(PORT, "127.0.0.1", () => {
    console.log(`\n[dev:memory] API  http://localhost:${PORT}/api/v1  (in-memory MongoDB, sending OFF)`);
    console.log(`[dev:memory] CORS ${CLIENT_URL}`);
    console.log("[dev:memory] admin@dev.local / DevAdmin#2026   staff@dev.local / DevStaff#2026\n");
  });

  const stop = async () => {
    server.close();
    await require("mongoose").disconnect();
    await mongod.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function seed() {
  const User = require("../src/models/User");
  const Customer = require("../src/models/Customer");
  const Lead = require("../src/models/Lead");
  const generateId = require("../src/utils/generateId");
  await Promise.all([User.init(), Customer.init(), Lead.init()]);

  await User.create({ name: "Dev Admin", email: "admin@dev.local", password: "DevAdmin#2026", role: "admin" });
  const staff = await User.create({ name: "Dev Staff", email: "staff@dev.local", password: "DevStaff#2026", role: "staff" });

  const cities = ["Pune", "Nashik", "Agra", "Delhi"];
  await Customer.insertMany(
    Array.from({ length: 40 }, (_, i) => ({
      customerId: generateId("CUS"),
      name: `Synthetic Patient ${i + 1}`,
      mobile: `90000${String(10000 + i).slice(-5)}`,
      city: cities[i % cities.length],
      gender: i % 2 ? "female" : "male",
      marketingOptIn: i % 3 === 0,
      source: "walk_in",
      status: i % 7 === 0 ? "inactive" : "active",
    }))
  );
  const priorities = ["low", "medium", "high", "urgent"];
  await Lead.insertMany(
    Array.from({ length: 12 }, (_, i) => ({
      leadId: generateId("LEAD"),
      name: `Synthetic Lead ${i + 1}`,
      mobile: `91111${String(10000 + i).slice(-5)}`,
      source: "website",
      status: "new",
      priority: priorities[i % 4],
      priorityRank: (i % 4) + 1,
      assignedTo: i % 2 ? staff._id : null,
      notes: `Synthetic note ${i + 1}`,
    }))
  );
}

main().catch((err) => {
  console.error("[dev:memory] failed:", err.message);
  process.exit(1);
});
