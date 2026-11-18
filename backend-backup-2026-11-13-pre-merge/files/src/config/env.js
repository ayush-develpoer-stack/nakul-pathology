/**
 * Centralized environment configuration.
 * Every other file should read config values from here instead of
 * touching process.env directly, so defaults/validation live in one place.
 *
 * SECURITY: this file intentionally does NOT provide fallback values for
 * JWT_SECRET, COOKIE_SECRET or any other security-sensitive secret. A
 * missing secret is treated as a fatal startup error rather than silently
 * falling back to a guessable/insecure default.
 */
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

// Always backend/.env, whatever the terminal's working directory (a bare
// dotenv.config() reads .env from process.cwd(), so starting the server from
// the repo root silently loaded nothing). Variables already set in the real
// environment (Render dashboard, nodemon.json, the shell) always win — dotenv
// never overrides them. No file (e.g. on Render) = process environment only.
const ENV_FILE = path.resolve(__dirname, "..", "..", ".env");
const envFileExists = fs.existsSync(ENV_FILE);
if (envFileExists) dotenv.config({ path: ENV_FILE });

if (envFileExists && process.env.NODE_ENV !== "test") {
  // A key defined twice is a classic local mistake: dotenv keeps the LAST
  // one. Names only — values are never printed.
  try {
    const counts = {};
    fs.readFileSync(ENV_FILE, "utf8")
      .split(/\r?\n/)
      .forEach((line) => {
        const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
        if (match) counts[match[1]] = (counts[match[1]] || 0) + 1;
      });
    const duplicates = Object.keys(counts).filter((k) => counts[k] > 1);
    // eslint-disable-next-line no-console
    console.info(`[config] Loaded environment file backend/.env${duplicates.length ? "" : " (no duplicate keys)"}.`);
    if (duplicates.length) {
      // eslint-disable-next-line no-console
      console.warn(`[config] backend/.env defines these keys more than once (the LAST one wins): ${duplicates.join(", ")}.`);
    }
  } catch {
    // Diagnostics only; never block startup.
  }
}

const NODE_ENV = process.env.NODE_ENV || "development";
const isProduction = NODE_ENV === "production";

// Secrets that must ALWAYS be present, in every environment, because the
// app is fundamentally insecure without them (auth cannot work safely).
const REQUIRED_ALWAYS = ["JWT_SECRET"];

// Additional variables that must be present specifically in production,
// where we fail fast rather than run with any kind of insecure default.
const REQUIRED_IN_PRODUCTION = [
  "MONGODB_URI",
  "JWT_SECRET",
  "COOKIE_SECRET",
  "CLIENT_URL",
  "CRM_URL",
];

function fatal(message) {
  // eslint-disable-next-line no-console
  console.error(`[config] FATAL: ${message}`);
  process.exit(1);
}

REQUIRED_ALWAYS.forEach((key) => {
  if (!process.env[key]) {
    fatal(
      `Missing required environment variable: ${key}. Set it in your .env file ` +
        "before starting the server (see .env.example). There is no insecure default."
    );
  }
});

if (isProduction) {
  const missing = REQUIRED_IN_PRODUCTION.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    fatal(
      `NODE_ENV=production but the following required environment variables are ` +
        `missing: ${missing.join(", ")}.`
    );
  }
  if (process.env.JWT_SECRET.length < 32) {
    fatal("JWT_SECRET is too short for production use (minimum 32 characters).");
  }
  if (process.env.COOKIE_SECRET.length < 32) {
    fatal("COOKIE_SECRET is too short for production use (minimum 32 characters).");
  }
}

// COOKIE_SECRET is not strictly required outside production (cookie-parser
// still works without one for unsigned cookies), but we never want a
// hardcoded fallback string. If it's missing in development, generate a
// random, process-local value (never logged, never persisted) so cookie
// signing still works but nothing insecure is baked into the codebase.
const cookieSecret =
  process.env.COOKIE_SECRET ||
  (() => {
    // eslint-disable-next-line global-require
    const crypto = require("crypto");
    // eslint-disable-next-line no-console
    console.warn(
      "[config] COOKIE_SECRET not set — generating a random development-only " +
        "secret for this process. Set COOKIE_SECRET in .env for stable cookie signing."
    );
    return crypto.randomBytes(32).toString("hex");
  })();

/** Integer env value clamped to [min, max]; `fallback` when unset/invalid. */
function boundedInt(raw, fallback, min, max) {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

const env = {
  NODE_ENV,
  PORT: parseInt(process.env.PORT, 10) || 5000,

  MONGODB_URI: process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/nakul_pathology_crm",

  JWT_SECRET: process.env.JWT_SECRET,
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || "7d",
  COOKIE_SECRET: cookieSecret,

  CLIENT_URL: process.env.CLIENT_URL || "http://localhost:3000",
  CRM_URL: process.env.CRM_URL || "http://localhost:3001",

  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME || "",
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY || "",
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET || "",

  META_WHATSAPP_ACCESS_TOKEN: process.env.META_WHATSAPP_ACCESS_TOKEN || "",
  META_WHATSAPP_PHONE_NUMBER_ID: process.env.META_WHATSAPP_PHONE_NUMBER_ID || "",
  META_WHATSAPP_BUSINESS_ACCOUNT_ID: process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID || "",
  META_WHATSAPP_VERIFY_TOKEN: process.env.META_WHATSAPP_VERIFY_TOKEN || "",
  WHATSAPP_SENDING_ENABLED: process.env.WHATSAPP_SENDING_ENABLED === "true",

  // Active outbound WhatsApp provider: "meta" (default) | "twilio" | "msg91". Any other
  // value is reported as invalid by the config status and blocks sending.
  WHATSAPP_PROVIDER: (process.env.WHATSAPP_PROVIDER || "meta").trim().toLowerCase(),

  // Twilio WhatsApp — all optional at startup; only required (and reported
  // as missing in the config status) when WHATSAPP_PROVIDER=twilio.
  TWILIO_ACCOUNT_SID: (process.env.TWILIO_ACCOUNT_SID || "").trim(),
  TWILIO_AUTH_TOKEN: (process.env.TWILIO_AUTH_TOKEN || "").trim(),
  TWILIO_WHATSAPP_FROM: (process.env.TWILIO_WHATSAPP_FROM || "").trim(),
  TWILIO_MESSAGING_SERVICE_SID: (process.env.TWILIO_MESSAGING_SERVICE_SID || "").trim(),
  TWILIO_STATUS_CALLBACK_URL: (process.env.TWILIO_STATUS_CALLBACK_URL || "").trim(),
  TWILIO_WEBHOOK_URL: (process.env.TWILIO_WEBHOOK_URL || "").trim(),
  TWILIO_TEST_CONTENT_SID: (process.env.TWILIO_TEST_CONTENT_SID || "").trim(),
  // Whether TWILIO_WHATSAPP_FROM is this account's WhatsApp Sandbox number
  // (Console → Messaging → Try it out → Send a WhatsApp message). Sandbox
  // numbers differ per account. "true" / "false"; unset = only Twilio's
  // classic shared Sandbox number (+14155238886) counts as Sandbox.
  TWILIO_WHATSAPP_SANDBOX:
    process.env.TWILIO_WHATSAPP_SANDBOX === "true" ? true : process.env.TWILIO_WHATSAPP_SANDBOX === "false" ? false : null,
  // MSG91 WhatsApp — all optional at startup; only required (and reported as
  // missing in the config status) when WHATSAPP_PROVIDER=msg91. Backend-only:
  // the auth key and webhook secret are never logged or sent to the browser.
  MSG91_AUTH_KEY: (process.env.MSG91_AUTH_KEY || "").trim(),
  // The integrated WhatsApp number shown in MSG91 → WhatsApp → Numbers, with
  // country code (e.g. 91XXXXXXXXXX). It is the SENDER, never a test phone.
  MSG91_WHATSAPP_NUMBER: (process.env.MSG91_WHATSAPP_NUMBER || "").trim(),
  // Shared secret that MSG91 webhooks must present (see msg91Webhook.service).
  MSG91_WEBHOOK_SECRET: (process.env.MSG91_WEBHOOK_SECRET || "").trim(),

  // Comma-separated test recipients. Empty means every Twilio send is refused.
  WHATSAPP_TEST_ALLOWLIST: (process.env.WHATSAPP_TEST_ALLOWLIST || "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean),
  // While true (the default), CRM replies and campaign sends are limited to
  // WHATSAPP_TEST_ALLOWLIST too (test-send always is). Set to exactly
  // "false" only once a production WhatsApp sender is live.
  WHATSAPP_RESTRICT_TO_ALLOWLIST: process.env.WHATSAPP_RESTRICT_TO_ALLOWLIST !== "false",

  // Campaign worker. Off unless exactly "true"; even then it only sends when
  // WHATSAPP_SENDING_ENABLED=true and the active provider is configured.
  WHATSAPP_CAMPAIGNS_ENABLED: process.env.WHATSAPP_CAMPAIGNS_ENABLED === "true",
  WHATSAPP_CAMPAIGN_MAX_PER_MINUTE: boundedInt(process.env.WHATSAPP_CAMPAIGN_MAX_PER_MINUTE, 20, 1, 600),
  WHATSAPP_CAMPAIGN_MAX_RECIPIENTS: boundedInt(process.env.WHATSAPP_CAMPAIGN_MAX_RECIPIENTS, 1000, 1, 20000),

  SMTP_HOST: process.env.SMTP_HOST || "",
  SMTP_PORT: process.env.SMTP_PORT || "",
  SMTP_USER: process.env.SMTP_USER || "",
  SMTP_PASS: process.env.SMTP_PASS || "",

  SEED_ADMIN_NAME: process.env.SEED_ADMIN_NAME || "Super Admin",
  SEED_ADMIN_EMAIL: process.env.SEED_ADMIN_EMAIL || "admin@nakulpathology.com",
  SEED_ADMIN_PHONE: process.env.SEED_ADMIN_PHONE || "9999999999",
  SEED_ADMIN_PASSWORD: process.env.SEED_ADMIN_PASSWORD || "",

  RATE_LIMIT_WINDOW_MINUTES: parseInt(process.env.RATE_LIMIT_WINDOW_MINUTES, 10) || 15,
  RATE_LIMIT_MAX_REQUESTS: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 300,
  PUBLIC_RATE_LIMIT_MAX_REQUESTS: parseInt(process.env.PUBLIC_RATE_LIMIT_MAX_REQUESTS, 10) || 60,
};

env.isProduction = isProduction;
env.isDevelopment = !isProduction;

module.exports = env;
