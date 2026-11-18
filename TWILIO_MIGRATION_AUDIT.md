# Twilio WhatsApp Migration — Technical Audit

**Project:** Nakul Pathology Lab CRM
**Audit type:** Read-only. No source file was modified, no package installed, nothing committed or pushed.
**Audit date:** 2026-10-15
**Scope:** `backend/` (Express API, deployed on Render) and `frontend/` (React CRM, deployed on Vercel), as checked out at
`C:\Users\Hp 440 G7\OneDrive\Desktop\nakul-pathology-crm`.

> All paths below are relative to that folder. No secret values are reproduced anywhere in this document.

---

## 1. Executive Summary

1. **The WhatsApp integration is almost entirely foundation code. The send path is never exercised.** `backend/src/services/whatsapp.service.js` defines `sendTemplateMessage`, `sendTextMessage` and `getMessageStatus`, but **nothing in the codebase calls them**. No code creates `Message` documents, no campaign can be sent, and inbound messages are only logged. The Twilio migration is therefore mostly **new wiring**. Very little working Meta logic needs to be replaced.
2. **The only live Meta pieces are the webhook endpoints**, `GET` and `POST /api/v1/whatsapp/webhook`. The GET handler is a Meta verify-token handshake. The POST handler updates `Message` rows by `wamid`, but since no rows are ever created, in practice it does nothing beyond logging.
3. **Campaigns are CRUD only.** You can create, edit and delete draft campaigns and preview the recipient count. "Send Campaign" and "Schedule Campaign" are hard-disabled buttons in the UI. There is no backend send endpoint, no queue, no retry, no rate limiting and no counter updates. The flow **CRM UI → API → Controller → (stops here)**: the provider is never reached.
4. **The architecture fits Twilio well.** The existing patterns carry over: backend-only credentials, a `WHATSAPP_SENDING_ENABLED` kill switch, a webhook router mounted before the global rate limiter, a global `express.urlencoded` parser (Twilio posts form-encoded data), and a generic `Message.messageId` string field. The proposed paths `/api/v1/whatsapp/twilio/webhook` and `/api/v1/whatsapp/twilio/status` slot straight into the existing router.
5. **The frontend never calls `graph.facebook.com`** and contains no provider credentials. Its only direct WhatsApp usage is `https://wa.me/<number>` click-to-chat links, which open the staff member's own WhatsApp app and do not use any API.
6. **🔴 CRITICAL, not Twilio-specific:** `backend/.env.example` is **tracked in git and pushed to the backend GitHub remote**, and it contains what appear to be **real production credentials**. See §19. These should be rotated before any further work, independent of Twilio.
7. **🟠 Frontend bug that will hide Twilio status:** `frontend/src/services/campaign.service.ts` does not unwrap the backend `{ success, message, data, pagination }` envelope. As a result the campaign list, campaign stats, campaign details and the "WhatsApp config status" card on the Campaigns page read the wrong fields. See §9.
8. **Recommended approach:** add a provider-agnostic layer with a new Twilio sender service and a new Twilio webhook service, make **additive** changes to the `Message` schema (`provider`, `direction`, etc.), and select the provider with an env flag. Trial → Production then becomes **an env-variable change plus creating approved Content Templates**, with no rewrite needed.

---

## 2. Current Project Architecture

### 2.1 Root structure

```
nakul-pathology-crm/            (NOT a git repo itself)
├── backend/                    (own git repo → github.com/…/nakul-pathology-crm-backend)
└── frontend/                   (own git repo → github.com/…/nakul-pathology-crm-frontend)
```

- **There is no public website in this repository.** CORS in `backend/src/app.js` allows `nakulpathologylab.in`, `localhost:5500` and a Netlify origin, so the public site lives in a separate repo. It reaches the backend only through `/api/v1/public/*`.
- There are no separate admin folders. "Admin" is a role (`admin` | `staff`) enforced by `backend/src/middleware/role.middleware.js` and `frontend/src/components/auth/RequireRole.tsx`.
- Neither repo has a `render.yaml`, `vercel.json`, `.nvmrc` or `.node-version`.

### 2.2 Backend (`backend/`): Node/Express, CommonJS

| Area | Path(s) |
|---|---|
| Entry | `backend/src/server.js` (connects DB, listens, graceful shutdown) |
| App / middleware chain | `backend/src/app.js` |
| Env config | `backend/src/config/env.js` (dotenv, fatal on missing `JWT_SECRET`, plus prod-required vars) |
| DB config | `backend/src/config/db.js` (mongoose, `serverSelectionTimeoutMS: 8000`, exits in prod on failure) |
| Cloudinary | `backend/src/config/cloudinary.js`, `backend/src/services/cloudinary.service.js` (signed, expiring download URLs) |
| Routes | `backend/src/routes/*.js` (16 files) |
| Controllers | `backend/src/controllers/*.js` (15 files) |
| Services | `backend/src/services/` → `cloudinary`, `customer`, `excel`, `settings`, `whatsapp`, `whatsappTemplate`, `whatsappWebhook` |
| Models | `backend/src/models/` → Activity, Appointment, AuditLog, Campaign, Customer, FollowUp, HealthPackage, Lead, Message, Prescription, Report, Settings, Test, User, WhatsappTemplate |
| Middleware | `auth.middleware.js` (JWT from Bearer header or `token` cookie), `role.middleware.js`, `validation.middleware.js` (Zod), `upload.middleware.js` (multer), `error.middleware.js` |
| Validators | `backend/src/validators/*.validator.js` (Zod). **There is no campaign validator.** |
| Utilities | `ApiError`, `apiResponse`, `asyncHandler`, `auditLog`, `generateId`, `generateToken`, `logger` (console wrapper), `normalizePhone`, `pagination`, `pick`, `seedAdmin` |
| Scripts | `backend/scripts/migrate-followups.js` |
| Background jobs / queues | **None.** No cron, Bull, Agenda, `setInterval` or queue anywhere. |
| HTTP client | `axios` (used only by `whatsapp.service.js`). There is no `fetch` usage. |

**Middleware order in `backend/src/app.js`:**
`trust proxy` (prod only) → `helmet` → `cors` (requests with no Origin are allowed) → `express.json` (2mb) → `express.urlencoded({extended:true})` (2mb) → `cookieParser` → `mongoSanitize` (**skipped for paths starting with `/api/v1/whatsapp/webhook`**) → `morgan` → **WhatsApp webhook router at `/api/v1/whatsapp`** → global `apiLimiter` on `/api` → health check → all other `/api/v1/*` routers → 404 → error handler.

**API mount map:**

| Mount | Router | Auth |
|---|---|---|
| `/api/v1/whatsapp` | `routes/whatsapp.routes.js` | **None (public webhook)**, own limiter (600/min) |
| `/api/v1/health` | inline | none |
| `/api/v1/auth` | `auth.routes.js` | mixed |
| `/api/v1/customers` | `customer.routes.js` | JWT |
| `/api/v1/leads` | `lead.routes.js` | JWT |
| `/api/v1/activities` | `activity.routes.js` | JWT |
| `/api/v1/follow-ups` | `followup.route.js` | JWT |
| `/api/v1/tests` | `test.routes.js` | JWT (writes admin) |
| `/api/v1/packages` | `package.routes.js` | JWT (writes admin) |
| `/api/v1/appointments` | `appointment.routes.js` | JWT |
| `/api/v1/reports` | `report.routes.js` | JWT |
| `/api/v1/prescriptions` | `prescription.routes.js` | JWT |
| `/api/v1/campaigns` | `campaign.routes.js` | JWT + **admin** |
| `/api/v1/whatsapp/templates` | `whatsappTemplate.routes.js` | JWT (writes admin) |
| `/api/v1/settings` | `settings.routes.js` | JWT (`/whatsapp` admin) |
| `/api/v1/dashboard` | `dashboard.routes.js` | JWT |
| `/api/v1/public` | `public.routes.js` | none, `publicLimiter` |

### 2.3 Frontend (`frontend/`): React 19, Vite, TypeScript, axios

- API client: `frontend/src/services/api.ts`. `baseURL = import.meta.env.VITE_API_URL`, JWT kept in `localStorage` (`nakul_crm_token`) and sent as a Bearer header.
- Routing: `frontend/src/routes/AppRoutes.tsx`. Sidebar: `frontend/src/components/layout/Sidebar/navConfig.ts`, with a "WhatsApp Marketing" section containing Campaigns and Templates.
- Domain modules: `pages/`, `components/`, `hooks/`, `services/` and `types/` for customers, leads, follow-ups, tests, packages, appointments, reports, prescriptions, campaigns, settings and dashboard.
- Several apparently duplicated or legacy component trees exist (`components/common/Dropdown/*`, `components/dashboard/customers/*`, `pages/tests/customers/*`, `pages/tests/dashboard/*`). They are unrelated to WhatsApp, but worth cleaning up later.

### 2.4 System summary

| System | Backend | Frontend | Notes |
|---|---|---|---|
| Customers | model/controller/service/routes/validator | `pages/customers/*`, `components/customers/*` | `mobile` (normalized 10-digit, unique), `whatsappNumber` (optional, unique when set), `consentStatus`, `marketingOptIn` |
| Leads | full CRUD | `pages/leads/*` | public contact form creates leads |
| Appointments | full CRUD + public create | `pages/appointments/*` | **no notifications of any kind** |
| Reports | upload, list, public search | `pages/reports/*` | public search returns 5-minute signed Cloudinary URLs |
| Prescriptions | public upload, staff read | `pages/prescriptions/*` | |
| Notifications | `Settings.notifications.*` flags only | Settings page toggles | **No email or WhatsApp notification is ever sent.** `nodemailer` is a dependency but is never `require`d. |
| Campaigns | draft CRUD only | `pages/campaigns/*` | see §8 |
| Templates | full CRUD, manual status | `pages/campaigns/CampaignTemplates.tsx` | no provider sync |
| Dashboard | `totalCampaigns` count only | `pages/dashboard/*` | no message stats |

---

## 3. Current WhatsApp Architecture

```
                 ┌──────────────────────────── CRM Frontend (Vercel) ───────────────────────────┐
                 │ Campaigns page ─► GET/POST/PATCH/DELETE /campaigns  (draft CRUD only)       │
                 │ Templates page ─► CRUD /whatsapp/templates           (local DB only)        │
                 │ Settings → WhatsApp ─► GET /settings/whatsapp        (config status only)   │
                 │ Customer/Lead/Follow-up ─► https://wa.me/<digits>    (manual click-to-chat) │
                 └───────────────────────────────────────────────────────────────────────────────┘
                                                   │
                 ┌──────────────────────────── Backend (Render) ────────────────────────────────┐
                 │ whatsapp.service.js ── axios ─► graph.facebook.com/v19.0  ✗ NEVER CALLED      │
                 │ GET  /api/v1/whatsapp/webhook  ◄── Meta verify handshake (verify token)       │
                 │ POST /api/v1/whatsapp/webhook  ◄── Meta events → update Message by wamid      │
                 │                                    (no Message rows exist → effectively no-op)│
                 │                                    inbound messages → logged only            │
                 └───────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Exact WhatsApp-Related Files

Legend: **BE** = backend, **FE** = frontend. "Meta dep" means the file is coupled to Meta's API or payload format.

### 4.1 Backend

| Path | What it does today | Side | Meta dep | Reusable for Twilio | Needs modification | Remove eventually |
|---|---|---|---|---|---|---|
| `backend/src/app.js` | Mounts the webhook router at `/api/v1/whatsapp` **before** the global limiter (L326-329). Skips `mongoSanitize` for `/api/v1/whatsapp/webhook*` (L288-293). Mounts templates at `/api/v1/whatsapp/templates` (L493-496). | BE | Partial (sanitize exemption is Meta-specific because of the `hub.*` query keys) | Yes | **No change required** if the Twilio routes are added to `whatsapp.routes.js` (see §10) | No |
| `backend/src/routes/whatsapp.routes.js` | `GET`/`POST /webhook` with its own 600/min limiter, no JWT | BE | Yes | Router and limiter: yes | **MODIFY**: add Twilio routes | Meta routes later |
| `backend/src/controllers/whatsapp.controller.js` | `verifyWebhook` (Meta handshake) and `receiveWebhook` (ack 200, fire-and-forget processing) | BE | Yes | The ack-then-process pattern: yes | **MODIFY**: add Twilio handlers (or put them in a new controller) | Meta handlers later |
| `backend/src/services/whatsapp.service.js` | Meta Cloud API wrapper (axios, `graph.facebook.com/v19.0`), `validateConfiguration()` (checks the 4 META vars) and `assertReadyToSend()` (kill switch). Send functions are **unused**. | BE | **Yes** | The kill-switch and config-status pattern: yes | **MODIFY**: make `validateConfiguration()` provider-aware, because Settings and the Campaign config card depend on it | Meta send functions later |
| `backend/src/services/whatsappWebhook.service.js` | Meta verify-token compare (timing-safe). Parses the Meta `entry[].changes[].value` shape, updates `Message` by `messageId === wamid`, and logs inbound messages. | BE | **Yes** | The status-timestamp logic is reusable as a concept | No (keep for Meta) | Later |
| `backend/src/models/Message.js` | Per-recipient outbound message row. `messageId` is commented "Meta's wamid". **Never written by any code.** | BE | Comment only | **Yes** (generic string ID) | **MODIFY** (additive fields, see §18) | No |
| `backend/src/models/Campaign.js` | Campaign draft with `templateName`, `audienceFilter` (Mixed) and counters `sent/delivered/read/failed` | BE | No | Yes | Later (template ref, `provider`) | No |
| `backend/src/controllers/campaign.controller.js` | Draft CRUD plus `GET /campaigns/whatsapp/config-status` (calls `whatsappService.validateConfiguration`). Uses `...req.body` with no validator. | BE | No (indirect) | Yes | Later, for the send engine and validation | No |
| `backend/src/routes/campaign.routes.js` | admin-only campaign routes | BE | No | Yes | Later (add a send route) | No |
| `backend/src/models/WhatsappTemplate.js` | Local template store: `name`, `category`, `language`, `status`, `metaTemplateId`, `metaStatus`, `body`, `variables`, `buttons`, `usageCount` | BE | Fields `metaTemplateId`/`metaStatus` | Mostly | **MODIFY** later: add `twilioContentSid` | `meta*` fields later |
| `backend/src/services/whatsappTemplate.service.js` | Template CRUD and a manual status change. `incrementUsage()` is **unused**. | BE | No | Yes | No (trial) | No |
| `backend/src/controllers/whatsappTemplate.controller.js` | Template CRUD + audit log | BE | No | Yes | No | No |
| `backend/src/routes/whatsappTemplate.routes.js` | JWT; writes admin-only. **`PATCH /:id/status` has no Zod validator** (the service validates the enum) | BE | No | Yes | No | No |
| `backend/src/validators/whatsappTemplate.validator.js` | Zod schemas; accepts `metaTemplateId` and `metaStatus` | BE | Field names | Yes | Later (add `twilioContentSid`) | `meta*` later |
| `backend/src/services/settings.service.js` | `getWhatsappSettings()` combines `Settings.whatsapp.enabled` with `validateConfiguration()` and returns only env var **names** | BE | Indirect | Yes | No (follows `validateConfiguration`) | No |
| `backend/src/controllers/settings.controller.js` / `backend/src/routes/settings.routes.js` | `GET /api/v1/settings/whatsapp` (admin) | BE | No | Yes | No | No |
| `backend/src/models/Settings.js` | `whatsapp.enabled` flag and `notifications.whatsappNotifications`. Explicitly stores no credentials. | BE | No | Yes | No | No |
| `backend/src/config/env.js` | Reads the 4 `META_WHATSAPP_*` vars and `WHATSAPP_SENDING_ENABLED` (L96-100) | BE | Yes | Yes | **MODIFY**: add `TWILIO_*` and `WHATSAPP_PROVIDER` | META vars later |
| `backend/.env.example` | Documents the META vars. **Also contains leaked secrets (§19).** | BE | Yes | — | **MODIFY** (sanitize + Twilio placeholders) | — |
| `backend/src/models/Customer.js` | `mobile`, `whatsappNumber`, `consentStatus`, `marketingOptIn` | BE | No | Yes | No | No |
| `backend/src/utils/normalizePhone.js` | Strips to a 10-digit Indian number (drops `91`) | BE | No | Yes (needs E.164 *formatting* on top) | No; add a new helper | No |
| `backend/src/models/Activity.js` / `backend/src/models/FollowUp.js` | Have a `"whatsapp"` type enum value (manual logging only) | BE | No | Yes | No | No |
| `backend/src/controllers/dashboard.controller.js` | `totalCampaigns` count | BE | No | Yes | No | No |
| `backend/README.md` | §12 "Future WhatsApp Setup" is Meta-centric | BE | Docs | — | Update docs later | — |
| `backend/package.json` | `axios` ^1.7.9 (lock: 1.19.0), `engines.node >=18`, **no `twilio`** | BE | No | Yes | Add `twilio` when implementing | No |

### 4.2 Frontend

| Path | What it does today | Calls | Meta dep | Needs modification |
|---|---|---|---|---|
| `frontend/src/pages/campaigns/Campaigns.tsx` | Campaign list, stats tiles, create/edit/delete, `WhatsappConfigCard` | `/campaigns`, `/campaigns/whatsapp/config-status` | No | Affected by the envelope bug (§9) |
| `frontend/src/pages/campaigns/CampaignDetails.tsx` | Detail view. **"Send Campaign" (L113) and "Schedule Campaign" (L116) are `disabled`.** Empty state for recipient tracking (L201). | `/campaigns/:id` | No | Later (send wiring), envelope bug |
| `frontend/src/pages/campaigns/CampaignTemplates.tsx` | Templates page | `/whatsapp/templates` | No | No |
| `frontend/src/components/campaigns/CampaignForm/CampaignForm.tsx` | 3-step draft wizard. `templateName` is a **free-text input** (L178-186), not a template picker. Copy says "Meta-approved". | — | Copy only | Copy change, picker later |
| `frontend/src/components/campaigns/AudienceBuilder/AudienceBuilder.tsx` | city/state/gender/source/tags filter | — | No | No |
| `frontend/src/components/campaigns/MessagePreview/MessagePreview.tsx` | Static mock bubble. Copy says "Meta-approved…". | — | Copy only | Copy change |
| `frontend/src/components/campaigns/WhatsappConfigCard.tsx` | Shows Connected/Not Configured and Sending Enabled/Disabled | — | No | No (generic) |
| `frontend/src/components/campaigns/CampaignTable.tsx`, `frontend/src/components/campaigns/CampaignFilters.tsx` | list UI | — | No | No |
| `frontend/src/components/campaigns/TemplateForm/TemplateForm.tsx`, `frontend/src/components/campaigns/TemplateTable/TemplateTable.tsx` | Template CRUD UI with manual status buttons | — | No | Later (Content SID field) |
| `frontend/src/services/campaign.service.ts` | Campaign API client. **Does not unwrap the envelope.** | backend only | No | **MODIFY** (bug fix) |
| `frontend/src/services/campaignTemplate.service.ts` | Template API client (unwraps correctly) | backend only | No | No |
| `frontend/src/types/campaign.ts`, `frontend/src/types/campaignTemplate.ts` | Types. `WhatsappConfigStatus = {configured, sendingEnabled}` | — | No | Optional (`missing`, `provider`) |
| `frontend/src/hooks/useCampaigns.ts`, `frontend/src/hooks/useCampaignTemplates.ts` | Data hooks | — | No | No (fixed through the service) |
| `frontend/src/pages/settings/Settings.tsx` (WhatsApp tab ~L1594-1700) + `frontend/src/services/settings.service.ts` + `frontend/src/hooks/useSettings.ts` + `frontend/src/types/settings.ts` | Read-only config status; renders the `missing` env var **names** generically | `/settings/whatsapp` | No | No. Twilio var names show up automatically once the backend is provider-aware. |
| `frontend/src/components/customers/CustomerTable/CustomerTable.tsx` (L117), `frontend/src/pages/customers/CustomerDetails.tsx` (L189), `frontend/src/pages/leads/LeadDetails.tsx` (L187), `frontend/src/components/followups/FollowUpList/FollowUpList.tsx` (L118), `frontend/src/components/dashboard/FollowUpWidget/FollowUpWidget.tsx` (L31-34) | `https://wa.me/<digits>` click-to-chat links | WhatsApp app | No | Not for Twilio. See the note below. |
| `frontend/src/routes/AppRoutes.tsx`, `frontend/src/components/layout/Sidebar/navConfig.ts`, `frontend/src/layouts/pageTitles.ts` | Routes and nav for `/campaigns`, `/campaigns/templates`, `/campaigns/:id` | — | No | Optional (a "Messages" page later) |

> **Note on the `wa.me` links:** stored numbers are 10-digit numbers without a country code, so `https://wa.me/9876543210` will **not** open the right chat; `wa.me` needs the international format (`919876543210`). This is a pre-existing low-severity UX bug, unrelated to the Twilio work.

**No WhatsApp UI exists for** inbox/conversations, appointment WhatsApp actions, report WhatsApp actions, or dashboard message statistics.

---

## 5. Current Meta Integration

| Capability | Status | Where |
|---|---|---|
| Outbound template send | Code exists, **never called** | `backend/src/services/whatsapp.service.js:63` |
| Outbound text send | Code exists, **never called** | `backend/src/services/whatsapp.service.js:87` |
| Status fetch | Code exists, never called (it is also not a valid Graph endpoint as written: it is built under `/{phone_number_id}/{messageId}`) | `backend/src/services/whatsapp.service.js:107` |
| Webhook verification (GET) | **Live** | `backend/src/controllers/whatsapp.controller.js:27` |
| Webhook events (POST) | **Live but effectively no-op** (no Message rows exist) | `backend/src/controllers/whatsapp.controller.js:53`, `backend/src/services/whatsappWebhook.service.js:166` |
| Webhook signature (`X-Hub-Signature-256`) | **Not implemented.** No `META_APP_SECRET` is configured. | — |
| Inbound persistence | **Not implemented** (log only) | `backend/src/services/whatsappWebhook.service.js:138` |
| Template sync with Meta | **Not implemented.** Template `status` is set by hand by an admin. | `backend/src/services/whatsappTemplate.service.js:270` |
| Phone formatting for API | **Not implemented.** `to` is passed through raw, while stored numbers are 10-digit with no country code. | — |

Whether the Meta webhook is currently registered in a Meta App dashboard **cannot be verified from code** (see §25).

---

## 6. Environment Variable Audit

All of these are read **only** in `backend/src/config/env.js` (L96-100). None of them is in `REQUIRED_ALWAYS` or `REQUIRED_IN_PRODUCTION`, so **startup never fails because of them**. Each defaults to `""` (or `false` for the flag).

| Variable | Used in | Required at startup | If missing | Keep during migration | Twilio equivalent |
|---|---|---|---|---|---|
| `META_WHATSAPP_ACCESS_TOKEN` | `whatsapp.service.js` (`validateConfiguration`, Bearer header) | No | Config shows "Not Configured"; any send throws 400 | Yes (until Meta is removed) | `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` (optionally an API Key SID/Secret for REST calls; the Auth Token is still needed for signature validation) |
| `META_WHATSAPP_PHONE_NUMBER_ID` | `whatsapp.service.js` (`validateConfiguration`, base URL) | No | same | Yes | `TWILIO_WHATSAPP_FROM` (e.g. `whatsapp:+<sandbox number>`) **or** `TWILIO_MESSAGING_SERVICE_SID` |
| `META_WHATSAPP_BUSINESS_ACCOUNT_ID` | `whatsapp.service.js` (`validateConfiguration` only, never used in a call) | No | same | Yes | **None.** Twilio manages the WABA link during sender registration. |
| `META_WHATSAPP_VERIFY_TOKEN` | `whatsapp.service.js` (`validateConfiguration`), `whatsappWebhook.service.js` (`isValidVerifyToken`) | No | GET `/webhook` always returns 403 | Yes, while the Meta webhook exists | **None.** Twilio authenticates with `X-Twilio-Signature` (HMAC-SHA1 using `TWILIO_AUTH_TOKEN`). |
| `WHATSAPP_SENDING_ENABLED` | `env.js` (`=== "true"`), `whatsapp.service.js`, `settings.service.js` | No | Treated as `false`, so sending is blocked | **Yes, keep as the provider-agnostic kill switch** | same variable |

**Proposed new variables** (backend only, all optional at startup):

| Variable | Purpose |
|---|---|
| `WHATSAPP_PROVIDER` | `twilio` \| `meta`, selects the active sender. Recommended so there is one switch. |
| `TWILIO_ACCOUNT_SID` | Account identifier (`AC…`) |
| `TWILIO_AUTH_TOKEN` | **Secret.** REST auth and webhook signature validation. |
| `TWILIO_WHATSAPP_FROM` | Trial: the sandbox sender (`whatsapp:+…`). Prod: dedicated number. |
| `TWILIO_MESSAGING_SERVICE_SID` | Optional (`MG…`). If set, used instead of `From`. |
| `TWILIO_STATUS_CALLBACK_URL` | e.g. `https://api.nakulpathologylab.in/api/v1/whatsapp/twilio/status` |
| `TWILIO_WEBHOOK_URL` | e.g. `https://api.nakulpathologylab.in/api/v1/whatsapp/twilio/webhook`. Used as the **exact URL for signature validation** (do not rebuild it from proxy headers). |
| `WHATSAPP_TEST_ALLOWLIST` (recommended) | Comma-separated E.164 numbers. While on the trial, sends to any other number are refused. |
| `TWILIO_VALIDATE_SIGNATURE` (optional) | Default `true`. Only for local tunnelling tests; must be `true` on Render. |

The other env vars (not WhatsApp-related) are `PORT`, `NODE_ENV`, `MONGODB_URI`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `COOKIE_SECRET`, `CLIENT_URL`, `CRM_URL`, `CLOUDINARY_*`, `SMTP_*`, `SEED_ADMIN_*` and `RATE_LIMIT_*`/`PUBLIC_RATE_LIMIT_MAX_REQUESTS`. The frontend has only `VITE_API_URL` (`frontend/.env`, gitignored, not tracked).

---

## 7. Message Model Audit

`backend/src/models/Message.js` contains exactly this (from source):

```js
campaign:     ObjectId ref "Campaign", default null, indexed
customer:     ObjectId ref "Customer", default null, indexed
phoneNumber:  String, required, trim
messageId:    String, trim, default "", indexed (NOT unique)   // comment: "Meta's wamid"
templateName: String, trim, default ""
status:       String enum ["pending","sent","delivered","read","failed"], default "pending", indexed
errorMessage: String, trim, default ""
sentAt:       Date, default null
deliveredAt:  Date, default null
readAt:       Date, default null
createdAt / updatedAt (timestamps: true)
```

| Requested field | Exists? | Notes |
|---|---|---|
| provider | ❌ | |
| providerMessageId | ⚠️ as `messageId` | Generic string, so it can hold either a wamid or a Twilio SID |
| wamid | ⚠️ as `messageId` | |
| direction | ❌ | Model is outbound-only by design |
| from | ❌ | |
| to | ⚠️ as `phoneNumber` | |
| customer | ✅ | |
| campaign | ✅ | |
| template | ⚠️ `templateName` (string) | No ObjectId ref to `WhatsappTemplate` |
| status | ✅ | No `queued` and no `undelivered` |
| queuedAt | ❌ | (`createdAt` can stand in) |
| sentAt / deliveredAt / readAt | ✅ | |
| failedAt | ❌ | |
| errorCode | ❌ | |
| errorMessage | ✅ | |
| metadata | ❌ | |
| body / content | ❌ | |

**Dual-ID (wamid + Twilio SID) difficulty: LOW.**
- No code ever writes `Message` rows, so the production collection is **very likely empty**. Please confirm in Atlas (§25).
- The formats cannot collide: wamids start with `wamid.`, Twilio SIDs start with `SM`/`MM`.
- Plan: keep `messageId` as the provider ID. Add `provider: { enum: ["meta","twilio"], default: "meta" }` so any historical rows are implicitly Meta. Add a **partial unique** compound index `{ provider: 1, messageId: 1 }` where `messageId` is a non-empty string. Always look up by `{ provider, messageId }`.
- Every change is **additive with defaults**, so no data migration script is required.

---

## 8. Campaign System Audit

| Component | Exists | Real or foundation |
|---|---|---|
| Model: `backend/src/models/Campaign.js` | ✅ | Real schema |
| Controller: `backend/src/controllers/campaign.controller.js` | ✅ | Real **draft CRUD** + config status |
| Routes: `backend/src/routes/campaign.routes.js` | ✅ | admin-only |
| Service | ❌ | none |
| UI: `frontend/src/pages/campaigns/*`, `frontend/src/components/campaigns/*` | ✅ | Real CRUD wizard, disabled send |
| Message creation | ❌ | Nothing creates `Message` rows |
| Recipient selection | ⚠️ | Count preview only: `Customer.countDocuments({ marketingOptIn: true, status: "active", ...audienceFilter })` |
| Bulk sending | ❌ | |
| Template selection | ⚠️ | Free-text `templateName`, not validated against `WhatsappTemplate` |
| Statistics | ⚠️ | Counter fields exist; nothing increments them |
| Sent/delivered/read/failed tracking | ⚠️ | Webhook updates `Message` only; there is no campaign roll-up |
| Queue/batch | ❌ | |
| Retry | ❌ | |
| Rate limiting (outbound) | ❌ | |

**Request trace**

```
CRM UI "Send Campaign" button  → disabled (CampaignDetails.tsx:113)   ✗ STOPS HERE (UI)
CRM UI "Save Draft"            → POST /api/v1/campaigns
  → campaign.routes.js (requireAuth + admin)
  → campaign.controller.createCampaign → Campaign.create(status:"draft")   ✗ STOPS HERE (no service/provider)
Provider (Meta/Twilio)         → never reached
Database                       → Campaign doc only; no Message docs
```

**Campaign issues to fix before a real send engine exists** (out of scope for the Twilio trial):
1. **No validator.** `createCampaign` spreads `...req.body` into `Campaign.create`, and `updateCampaign` does `Object.assign(campaign, req.body)`. An admin request can set `status`, the counters, `createdBy`, `startedAt` and so on directly. Once sending exists, a PATCH that sets `status: "in_progress"` would bypass any send-guard logic.
2. **Raw `audienceFilter` goes into a Mongo query.** `mongoSanitize` strips `$` keys, which limits injection, but the filter is not whitelisted.
3. **Tag targeting is incorrect.** The UI sends `tags: string[]`, and `{ tags: ["a","b"] }` in Mongo means *exact array equality*, not "has any of these tags". The recipient count will be wrong for tag filters.
4. **`consentStatus` is ignored** by targeting (only `marketingOptIn` is checked).

---

## 9. Frontend WhatsApp Audit

- **`graph.facebook.com` is never called from the frontend.** ✅ No `twilio`, `access_token`, `META_`, or `verify_token` strings appear in `frontend/src` or `frontend/index.html`. ✅
- The only frontend env var is `VITE_API_URL`. `frontend/.env` is gitignored and **not tracked**. ✅
- **The target architecture (Frontend → Backend → Provider) is already respected.** ✅

**Bug: campaign API envelope not unwrapped** (`frontend/src/services/campaign.service.ts`)
The backend returns `{ success, message, data, pagination }` (`backend/src/utils/apiResponse.js`). `campaign.service.ts` returns `res.data` (the whole envelope) typed as `Paginated<Campaign>`, `Campaign` or `WhatsappConfigStatus`. The consequences:
- `useCampaigns` reads `res.items`, `res.total` and `res.totalPages` → all `undefined`.
- The stat tiles in `Campaigns.tsx` read `response.total` → always `0`.
- `WhatsappConfigCard` reads `status.configured` and `status.sendingEnabled` from the envelope → **always "Not Configured / Disabled"**, even after Twilio is configured.
- `CampaignDetails` receives the envelope instead of the campaign.

By comparison, `customer.service.ts` and `campaignTemplate.service.ts` unwrap correctly. Please confirm this against the deployed CRM; it is visible in the code as checked out. **This matters for Twilio testing**, because the Campaigns page config card will not reflect the new Twilio status until it is fixed. (The Settings → WhatsApp tab uses `settings.service.ts`, which does unwrap.)

Missing UI, all of which is **not required for the trial**: message log/inbox, a test-send form, a template picker in the campaign wizard, per-recipient delivery table, and dashboard message stats.

---

## 10. Webhook Audit

| Aspect | Current behaviour (Meta) |
|---|---|
| URL | `GET` and `POST https://api.nakulpathologylab.in/api/v1/whatsapp/webhook` |
| GET verification | `hub.mode === "subscribe"` plus a timing-safe verify-token compare; echoes `hub.challenge` as text/plain; otherwise 403 |
| POST | `res.sendStatus(200)` first, then `processWebhookPayload(req.body)` fire-and-forget |
| Auth exemption | No JWT (router has no `requireAuth`) |
| Rate-limit exemption | Mounted **before** the global `/api` limiter. Has its own 600 req/min limiter, applied per-route. |
| Sanitization exemption | `mongoSanitize` skipped for `req.path.startsWith("/api/v1/whatsapp/webhook")` |
| Body parsing | Global `express.json` and `express.urlencoded({extended:true})`, 2mb. **No raw body is preserved.** |
| Async processing | In-process, after the response. Not durable: lost if the Render instance restarts mid-processing. |
| Error handling | `processWebhookPayload` catches everything and logs |
| Logging | morgan `combined` (prod) for every request, plus `logger.info` per status/inbound. Inbound logs include the sender's phone number (PII in logs). |
| Status processing | Updates `status` and the first-seen timestamp. **No monotonic guard** (a late `delivered` can overwrite `read`). |
| Incoming processing | Log only |
| Signature verification | **None** for POST |

**Will switching to Twilio cause body-parsing or signature problems?**
- **Body parsing: no.** Twilio posts `application/x-www-form-urlencoded`, which is already parsed globally into a flat `req.body`. Twilio parameter names (`MessageSid`, `MessageStatus`, `From`, `To`, `Body`, `ErrorCode`, `NumMedia`, `MediaUrl0`, `ProfileName`, `WaId`, `AccountSid`, …) contain no `.` or `$`, so `mongoSanitize` will not alter them. That is important because signature validation is computed over these exact params. The new paths therefore **do not need a sanitize exemption.**
- **Signature: needs care.** `X-Twilio-Signature` is an HMAC over the **exact public URL Twilio called** plus the sorted POST params. On Render the app sees an internal URL behind a proxy (`trust proxy` is only set when `NODE_ENV=production`). **Validate against the configured `TWILIO_WEBHOOK_URL` / `TWILIO_STATUS_CALLBACK_URL` strings**, not against `req.protocol + req.get('host')`. If the URL differs by even a trailing slash or query string, validation fails.
- **Response format:** for inbound-message webhooks Twilio expects TwiML. The current Meta pattern of `sendStatus(200)` returns the text body `OK`, which Twilio would log as an invalid-TwiML warning. The Twilio inbound handler should respond `200` with `Content-Type: text/xml` and `<Response></Response>` (or `204`). A bare `200`/`204` is fine for status callbacks.

**Are `/api/v1/whatsapp/twilio/webhook` and `/api/v1/whatsapp/twilio/status` appropriate? Yes.** Adding them to `backend/src/routes/whatsapp.routes.js` automatically gives them:
- no JWT (correct for server-to-server),
- exemption from the global 300-per-15-minute limiter (because the router is mounted before it),
- the existing `webhookLimiter` (re-use it),
- form-body parsing.

They do **not** collide with `/api/v1/whatsapp/templates` (a different router) or the Meta `/webhook` path.

---

## 11. Twilio Compatibility Analysis

| Concern | Current state | Twilio requirement | Gap |
|---|---|---|---|
| Recipient address | 10-digit local numbers (`normalizePhone`) | `whatsapp:+91XXXXXXXXXX` | **New helper** `toWhatsAppAddress()` (10-digit → `+91…`) and the reverse for inbound (`whatsapp:+91…` → 10-digit) to match `Customer.mobile`/`whatsappNumber` |
| Send API | Meta JSON to Graph | Form POST `/2010-04-01/Accounts/{SID}/Messages.json` with `To`, `From` or `MessagingServiceSid`, `Body` **or** `ContentSid`+`ContentVariables`, `StatusCallback` | New sender service |
| Templates | `name` + `language` + `components` (Meta style); local `metaTemplateId` | **Content API**: `ContentSid` (`HX…`) + `ContentVariables` JSON `{"1":"…"}` | Add `twilioContentSid` to `WhatsappTemplate`. For the trial, free-form `Body` inside the 24h session window is enough. |
| Message ID | `wamid.*` | `SM…` / `MM…` | `messageId` + `provider` |
| Status values | `sent/delivered/read/failed` | `queued`, `sending`, `sent`, `delivered`, `read`, `undelivered`, `failed` (also `accepted`, `scheduled`, `canceled` with Messaging Services) | Mapping (§12) and an enum addition |
| Error info | `errors[0].title/message` | `ErrorCode` (+ sometimes `ErrorMessage`) | Add an `errorCode` field |
| Webhook auth | Verify token (GET) | `X-Twilio-Signature` HMAC | New validator |
| Webhook shape | nested JSON `entry/changes/value` | flat form fields, one event per request | New parser |
| Inbound | log only | `From`, `Body`, `NumMedia`, `MediaUrl{n}`, `ProfileName`, `WaId` | New persistence |
| Kill switch | `WHATSAPP_SENDING_ENABLED` | same | Reuse |
| Config status UI | `validateConfiguration()` → `missing[]` names | same contract | Make provider-aware |

---

## 12. Twilio Trial Integration Plan

**Trial constraints, to confirm in your Twilio console:** the trial WhatsApp sender is almost certainly the **Twilio Sandbox**. That means a shared sender number, recipients who must first send the `join <keyword>` message, free-form messages allowed only inside a 24-hour session after the user messages you, and sandbox-provided templates only. Trial accounts may also only message verified numbers.

### 12.1 Outgoing

```
Admin (CRM, JWT, admin role)
 → POST /api/v1/whatsapp/test-send   { customerId | phone, body }   (NEW, admin-only)
 → twilioWhatsapp.service.sendMessage()
      guards: WHATSAPP_SENDING_ENABLED, WHATSAPP_PROVIDER=twilio, config present,
              recipient in WHATSAPP_TEST_ALLOWLIST, phone valid (isValidIndianMobile)
      1. Message.create({ provider:"twilio", direction:"outbound", status:"pending", ... })
      2. Twilio Messages.create({ To, From|MessagingServiceSid, Body, StatusCallback })
      3. update row: messageId = sid, status = mapped(response.status) (usually "queued"), queuedAt
         on API error: status "failed", errorCode, errorMessage (no automatic retry)
 → Twilio → Sandbox sender → verified tester's WhatsApp
```

Creating the row **before** calling Twilio means a crash between the two steps leaves a visible `pending` row rather than an untracked message.

### 12.2 Incoming

```
Tester replies → Twilio → POST /api/v1/whatsapp/twilio/webhook
 → validate X-Twilio-Signature against TWILIO_WEBHOOK_URL; check AccountSid === TWILIO_ACCOUNT_SID
 → respond 200 text/xml "<Response></Response>" immediately
 → async: idempotent upsert Message { provider:"twilio", direction:"inbound", messageId: MessageSid,
           from, to, body, status:"received", customer: lookup by normalized phone (whatsappNumber || mobile) }
 → (optional) if body matches STOP/UNSUBSCRIBE → customer.marketingOptIn = false
```

Note: `Activity.user` is **required**, so inbound messages cannot be written to the Activity timeline without a "system" user. Persist to `Message` for the trial and defer timeline integration.

### 12.3 Status callbacks

```
Twilio → POST /api/v1/whatsapp/twilio/status
 → validate signature against TWILIO_STATUS_CALLBACK_URL; respond 204
 → async: Message.findOne({ provider:"twilio", messageId: MessageSid })  (never create)
 → apply mapped status only if it is a forward transition (see below); set timestamp; store errorCode
```

### 12.4 Status mapping

| Twilio `MessageStatus` | App `status` | Timestamp | Notes |
|---|---|---|---|
| `accepted`, `scheduled`, `queued` | `queued` *(new enum value)* | `queuedAt` | Alternatively map to the existing `pending` to avoid any enum change |
| `sending` | `queued` | — | |
| `sent` | `sent` | `sentAt` | |
| `delivered` | `delivered` | `deliveredAt` | |
| `read` | `read` | `readAt` | |
| `undelivered` | `failed` | `failedAt` *(new)* | keep the raw value in `providerStatus` *(new)* |
| `failed` | `failed` | `failedAt` | `errorCode`, e.g. 63016 (outside 24h window) or 63015 (sandbox recipient not joined). Verify codes against Twilio docs. |
| `canceled` | `failed` | `failedAt` | rare |
| `received` (inbound) | `received` *(new, inbound only)* | — | |

**Transition guard:** rank `pending(0) < queued(1) < sent(2) < delivered(3) < read(4)`. Only move forward. `failed` is accepted only from `pending`/`queued`/`sent`, so it never overwrites `delivered`/`read`. Twilio callbacks can arrive **out of order**, and the current Meta handler has no such guard.

**Schema gaps for this plan:** `provider`, `direction`, `from`, `body`, `errorCode`, `failedAt`, `queuedAt`, `providerStatus`, the status enum values `queued`/`received`, and the unique index. All are additive (§18).

---

## 13. Trial → Production Migration Plan

The recommended architecture moves to production **mainly through configuration**:

| Step | Code change? |
|---|---|
| 1. Upgrade the Twilio account | No |
| 2-4. Buy/register a number, register it as a WhatsApp sender, set up the business profile | No (Twilio and Meta consoles) |
| 5. Create approved WhatsApp templates in Twilio Content Template Builder | **Data only:** store each `HX…` ContentSid in `WhatsappTemplate.twilioContentSid` |
| 6. Optional Messaging Service | No. Set `TWILIO_MESSAGING_SERVICE_SID`; the sender prefers it over `From`. |
| 7. Move Render from the sandbox sender to the production sender | **Env only:** `TWILIO_WHATSAPP_FROM` (or MG SID) |
| 8. Enable `WHATSAPP_SENDING_ENABLED=true` and clear or widen `WHATSAPP_TEST_ALLOWLIST` | Env only |
| 9-11. Test send, inbound and callbacks | No. Point the production sender's webhook at the same URLs. |
| 12. Enable CRM campaigns | **Yes. This is the one genuinely new feature:** the bulk send engine (queue, throttling, consent filter, template variables, counter roll-up, Send button). It is not needed for the trial. |

The one code path that differs is **template messages** (`ContentSid` + `ContentVariables`). Build it into the sender during the trial; the sandbox's own templates can be used to test it.

---

## 14. Required File Changes (MODIFY)

| File | Change | Reason |
|---|---|---|
| `backend/src/config/env.js` | Add `WHATSAPP_PROVIDER`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`, `TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_STATUS_CALLBACK_URL`, `TWILIO_WEBHOOK_URL`, `WHATSAPP_TEST_ALLOWLIST`. All optional, **not** fatal. | Central config pattern |
| `backend/.env.example` | **Remove all real values** (§19). Add Twilio placeholders with empty values. | Security and documentation |
| `backend/src/models/Message.js` | Additive fields, enum values and indexes (§18) | Dual provider and inbound support |
| `backend/src/routes/whatsapp.routes.js` | Add `POST /twilio/webhook`, `POST /twilio/status` (public, `webhookLimiter`) and `POST /test-send` (`requireAuth` + `requireRole("admin")` + Zod validator + a tight limiter) | Twilio endpoints |
| `backend/src/controllers/whatsapp.controller.js` | Add `receiveTwilioInbound`, `receiveTwilioStatus` and `testSend` (or put them in a new `twilioWhatsapp.controller.js`, which keeps Meta code untouched) | |
| `backend/src/services/whatsapp.service.js` | Make `validateConfiguration()` provider-aware: when `WHATSAPP_PROVIDER=twilio`, check the Twilio vars and return their **names** in `missing`; add `provider` to the result | Settings and the Campaign config card depend on it |
| `frontend/src/services/campaign.service.ts` | Unwrap `{data, pagination}` like `customer.service.ts` does | Pre-existing bug; the config card is otherwise always "Not Configured" |
| `backend/package.json` / `backend/package-lock.json` | Add `twilio` (when approved) | SDK (§10 rationale in Phase 10 below) |

Later (not needed for the minimum trial): `backend/src/models/WhatsappTemplate.js` and `backend/src/validators/whatsappTemplate.validator.js` (add `twilioContentSid`), `backend/src/controllers/campaign.controller.js` (validator, send endpoint), `frontend/src/components/campaigns/CampaignForm/CampaignForm.tsx` and `frontend/src/components/campaigns/MessagePreview/MessagePreview.tsx` (copy and template picker), `frontend/src/types/campaign.ts` (`missing`, `provider`), and `backend/README.md` (docs).

## 15. New Files Required

| New file | Purpose |
|---|---|
| `backend/src/services/twilioWhatsapp.service.js` | Outbound send (Body or ContentSid), guards, row-before-send, status mapping helper, E.164 formatting |
| `backend/src/services/twilioWebhook.service.js` | Signature validation, AccountSid check, inbound persistence (idempotent), status reconciliation with the transition guard |
| `backend/src/validators/whatsapp.validator.js` | Zod schema for `POST /test-send` (`phone` or `customerId`, `body` up to 1600 chars) |
| `backend/src/utils/whatsappAddress.js` *(or extend `normalizePhone.js`)* | `toWhatsAppAddress("9876543210") → "whatsapp:+919876543210"`, `fromWhatsAppAddress()` |
| *(optional)* `backend/src/controllers/twilioWhatsapp.controller.js` | Keeps the Twilio handlers separate from the Meta controller |
| *(optional, later)* `backend/src/services/whatsappProvider.js` | Facade: `send()` dispatches on `WHATSAPP_PROVIDER` |
| *(optional, later)* a frontend "Messages" page / test-send panel | Not required for the trial; Postman or curl with an admin JWT is enough |

## 16. Files That Can Stay Unchanged

`backend/src/app.js` · `backend/src/server.js` · `backend/src/config/db.js` · `backend/src/middleware/*` · `backend/src/services/whatsappWebhook.service.js` · `backend/src/services/whatsappTemplate.service.js` · `backend/src/controllers/whatsappTemplate.controller.js` · `backend/src/routes/whatsappTemplate.routes.js` · `backend/src/services/settings.service.js` · `backend/src/controllers/settings.controller.js` · `backend/src/routes/settings.routes.js` · `backend/src/models/Settings.js` · `backend/src/models/Customer.js` · `backend/src/models/Campaign.js` (for the trial) · `backend/src/utils/normalizePhone.js` · `backend/src/utils/logger.js` · `frontend/src/services/api.ts` · `frontend/src/components/campaigns/WhatsappConfigCard.tsx` · `frontend/src/pages/settings/Settings.tsx` · all non-WhatsApp modules.

## 17. Files That May Eventually Be Removed (REMOVE LATER, only after Twilio is proven in production)

| File / part | When |
|---|---|
| `backend/src/services/whatsappWebhook.service.js` | After the Meta webhook is de-registered |
| Meta handlers in `backend/src/controllers/whatsapp.controller.js` and the `/webhook` routes in `backend/src/routes/whatsapp.routes.js` | same |
| Meta send functions and `GRAPH_BASE_URL` in `backend/src/services/whatsapp.service.js` | same |
| `META_WHATSAPP_*` in `backend/src/config/env.js` and `backend/.env.example` | same |
| `mongoSanitize` exemption in `backend/src/app.js` (L288-293) | Once `/webhook` is gone. Removing it restores sanitization everywhere. |
| `metaTemplateId`/`metaStatus` in `backend/src/models/WhatsappTemplate.js` and its validator | After templates are migrated to `twilioContentSid` |

## 18. Database Changes Required

All **additive with defaults**. No migration script is needed and old documents stay valid.

`Message` (`backend/src/models/Message.js`):
```
provider:       { type: String, enum: ["meta","twilio"], default: "meta", index: true }
direction:      { type: String, enum: ["outbound","inbound"], default: "outbound", index: true }
from:           { type: String, trim: true, default: "" }
body:           { type: String, default: "" }            // see §20 re: PHI
providerStatus: { type: String, default: "" }            // raw Twilio/Meta status
errorCode:      { type: String, default: "" }
queuedAt:       { type: Date, default: null }
failedAt:       { type: Date, default: null }
metadata:       { type: Mixed, default: {} }             // e.g. NumMedia, ProfileName — no secrets
status enum:    add "queued", "received"
index:          { provider: 1, messageId: 1 }, unique, partialFilterExpression: { messageId: { $type: "string", $gt: "" } }
```
- Mongoose builds indexes at startup (autoIndex). If the collection already had duplicate non-empty `messageId`s, index creation would fail and be logged (the app keeps running). Checking `db.messages.countDocuments()` in Atlas first is recommended.
- Later: `WhatsappTemplate.twilioContentSid` (String, default ""); `Campaign.provider` / `template` ref.

---

## 19. Security Findings

| # | Severity | Finding |
|---|---|---|
| S1 | **CRITICAL** | **Potential exposed credential found at `backend/.env.example`.** The file is **tracked in git and present in the remote** (`origin` → GitHub backend repo). It appears to contain real values for the MongoDB Atlas connection string (including a DB user password), `JWT_SECRET`, `COOKIE_SECRET`, the Cloudinary API key and secret, the seed admin password, and a stray line that looks like a password note. **All of these should be rotated** (Atlas DB user password, JWT and cookie secrets, which will log users out, Cloudinary API secret, admin password), the file should be replaced with placeholders, and you should consider purging git history. If the GitHub repo is or ever was public, treat these as compromised. |
| S2 | Info | `backend/.env` is local and gitignored (correct). It contains a malformed line without `KEY=` that looks like a password note; tidy it up. Never commit it. |
| S3 | **HIGH** (future) | The Meta POST webhook has **no signature validation**. Anyone can POST fake status events. Impact today is nil (no Message rows), but it would become real once messages exist. The Twilio endpoints **must** validate `X-Twilio-Signature` from day one. |
| S4 | MEDIUM | The campaign controller has **no input validation** (mass assignment of `status`, counters, `createdBy`) and puts the raw `audienceFilter` into a query. This must be fixed before the bulk send endpoint exists. |
| S5 | MEDIUM | **Mass-send abuse.** When campaigns are enabled, a single admin action could message about 20k customers. You will need explicit confirmation, a per-day cap, throttling, a consent filter (`marketingOptIn` **and** `consentStatus === "granted"`), and an audit log entry per send. |
| S6 | MEDIUM | Template `status` ("approved") is set manually by any admin and is not synced with the provider. Do not rely on it as proof of provider approval. |
| S7 | LOW | Inbound WhatsApp logs include phone numbers (PII in Render logs). Mask them (e.g. `+91XXXXXX3210`). |
| S8 | LOW | The frontend stores the JWT in `localStorage` (XSS exposure). This is pre-existing and not Twilio-related. |
| S9 | OK | **No provider secrets in the frontend.** `frontend/.env` holds only `VITE_API_URL` and is not tracked. No direct Graph/Twilio calls. |
| S10 | OK | `whatsapp.service.js` never logs the token. Errors log only `err.message`. The Settings API returns env var **names** only. **Keep this for Twilio:** the axios/Twilio error objects contain request config including auth headers, so never log the whole `err` object. |
| S11 | OK | CORS allows requests with no Origin, which is correct for Twilio server-to-server calls. Webhooks are not cookie-authenticated, so CORS is irrelevant to their security; the signature is what protects them. |
| S12 | Note | Phone validation: `isValidIndianMobile()` exists but is not applied to `Message.phoneNumber`. The new send path must validate before calling Twilio, and enforce the trial allowlist. |
| S13 | Note | Template variables: once `ContentVariables` are filled from customer data, cap their length, strip newlines where Twilio forbids them, and never accept arbitrary variable values from the client for bulk sends. |

---

## 20. Patient Data / Privacy Considerations

These are technical observations, not legal advice.

| Data | Current WhatsApp exposure | Risk if messaged |
|---|---|---|
| Test results / reports | None. Reports are Cloudinary files; the public search gives 5-minute signed URLs after a `patientId` + mobile match. | A report link sent over WhatsApp lives in chat history, may be forwarded, and Twilio stores message bodies in its logs. |
| Report links | Not sent | A signed URL embedded in a message expires (good), but long-lived links would be a real exposure |
| Prescriptions | Not sent | High sensitivity |
| Appointments | Not sent | Test or package names can reveal health conditions |
| Phone numbers | Stored as 10-digit; would be sent to Twilio | Necessary, but mask in logs |
| Patient identifiers (`patientId`, `reportId`) | Not sent | Together with a phone number they act as a lookup credential for public report search |

**Recommendations**
- Keep WhatsApp messages **minimal**: "Your report is ready. Download it at nakulpathologylab.in → Reports using your Patient ID." Avoid test names, results, diagnoses, prescription details, or report/download links.
- Do **not** put `patientId` and mobile in the same message, because that pair unlocks public report search.
- Consider **not persisting full `body`** for outbound templated messages: store the template reference and variables instead, or redact. Twilio also retains bodies; review its message-redaction settings.
- Honour opt-out (STOP) and only market to `marketingOptIn` **and** `consentStatus: "granted"`.
- Keep campaign (marketing) content separate from transactional (report/appointment) notifications.

---

## 21. Risks and Severity

| Risk | Level | Notes / mitigation |
|---|---|---|
| Leaked credentials in the tracked `.env.example` | **CRITICAL** | Rotate now (S1) |
| Webhook spoofing (Twilio endpoints without signature check) | **HIGH** | Validate the signature and AccountSid; validate against the configured URL |
| Secret exposure through logging of SDK/axios error objects | **HIGH** | Log only `code`, `status` and `message` |
| Retry causing duplicate sends | **HIGH** (when campaigns ship) | No automatic retry of `Messages.create` on timeout/5xx without an idempotency check; row-before-send; manual retry only |
| Breaking existing CRM | **LOW** | Changes are additive; new routes are isolated; Meta stays |
| Breaking campaigns | **LOW** | Campaigns don't send today; the frontend envelope fix is isolated |
| Duplicate webhook processing | **MEDIUM** | Unique `{provider, messageId}` index; upsert inbound by `MessageSid`; status updates are idempotent |
| Meta and Twilio both processing the same message | **LOW** | Separate paths, ID formats and `provider` field; lookups filtered by provider |
| Invalid / out-of-order status transitions | **MEDIUM** | Monotonic rank guard (§12.4). The current Meta handler lacks it. |
| Missing idempotency | **MEDIUM** | As above |
| Render cold starts / timeouts | **MEDIUM** (unknown plan) | On Render free tier the instance sleeps and the first webhook may exceed Twilio's timeout. Ack fast; consider a paid instance for production. |
| In-process async lost on restart | **LOW** (trial) / **MEDIUM** (prod) | Acceptable for the trial; use a durable queue for campaigns |
| Signature URL mismatch behind the Render proxy | **MEDIUM** | Use the env-configured URLs; match exactly what is set in Twilio |
| MongoDB schema compatibility | **LOW** | Additive and defaulted; check for duplicates before the unique index |
| Historical Meta message compatibility | **LOW** | `provider` defaults to `"meta"`; collection likely empty |
| Sandbox limits confusing tests (24h window, join keyword) | **LOW** | Expect errors 63016/63015; document them for testers |
| Mass/bulk-send abuse | **MEDIUM** (future) | S5 controls |

---

## 22. Recommended Implementation Order

0. **(Out of band, now)** Rotate the leaked credentials and sanitize `backend/.env.example`.
1. Fix `frontend/src/services/campaign.service.ts` (envelope unwrap). Tiny and isolated, and it makes config status visible.
2. Add the Twilio env vars to `backend/src/config/env.js` (non-fatal) and the placeholders to `.env.example`.
3. Make `Message` schema changes (additive).
4. Add the phone address helper.
5. Make `validateConfiguration()` provider-aware, so the Settings tab shows Twilio config status.
6. Install `twilio` and build `twilioWhatsapp.service.js` (sends blocked by default: `WHATSAPP_SENDING_ENABLED=false`).
7. Build `twilioWebhook.service.js` with signature validation, status reconciliation and inbound persistence.
8. Add the routes and controller (`/twilio/webhook`, `/twilio/status`, `/test-send`).
9. Deploy to Render with sending **disabled**; configure the Twilio Sandbox webhook URL; test inbound and the signature check.
10. Enable sending with the allowlist set to the tester numbers; test outbound and status callbacks.
11. *(Later)* Template ContentSid support, then campaign validator, send engine, UI, production sender.

## 23. Testing Checklist

- [ ] With no `TWILIO_*` vars, the server starts and Settings shows "Not configured" listing the Twilio var **names**.
- [ ] `WHATSAPP_SENDING_ENABLED=false` → `/test-send` returns 400 and no Twilio call is made.
- [ ] Recipient not in the allowlist → refused, no Twilio call.
- [ ] Non-admin or unauthenticated `/test-send` → 403/401.
- [ ] Valid send → a `Message` row with `provider:"twilio"`, `messageId` starting with `SM`, `status:"queued"`.
- [ ] Status callbacks advance the row through `sent → delivered → read` with timestamps.
- [ ] Replaying the same callback → no change and no error.
- [ ] Sending `delivered` after `read` → stays `read`.
- [ ] Sending to a number that hasn't joined the sandbox → `failed` with `errorCode` stored.
- [ ] Message sent outside the 24h window → `failed` (63016) recorded.
- [ ] Inbound reply → `Message` `direction:"inbound"`, linked to the correct customer via the normalized number.
- [ ] Same inbound `MessageSid` posted twice → one row.
- [ ] POST to `/twilio/status` or `/twilio/webhook` with a missing or bad `X-Twilio-Signature` → 403, nothing written.
- [ ] Wrong `AccountSid` with a valid-looking request → rejected.
- [ ] Inbound response is `text/xml` `<Response></Response>` and the Twilio debugger shows no TwiML warnings.
- [ ] Meta `GET /api/v1/whatsapp/webhook` behaviour is unchanged.
- [ ] Campaign list, stats and config card render correctly after the envelope fix.
- [ ] Render logs contain no Auth Token and no full phone numbers.

## 24. Deployment Checklist

- [ ] Credentials from S1 rotated; Render env updated with the new `MONGODB_URI`, `JWT_SECRET`, `COOKIE_SECRET` and Cloudinary secret.
- [ ] Render env: `WHATSAPP_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`, `TWILIO_STATUS_CALLBACK_URL`, `TWILIO_WEBHOOK_URL`, `WHATSAPP_TEST_ALLOWLIST`, `WHATSAPP_SENDING_ENABLED=false` initially.
- [ ] Confirm `NODE_ENV=production` on Render (enables `trust proxy`).
- [ ] Confirm the Render Node version (set `NODE_VERSION` or `engines`; the code requires ≥18).
- [ ] Twilio Console → Sandbox settings: "When a message comes in" = `TWILIO_WEBHOOK_URL` (POST). The status callback is sent per message by the backend.
- [ ] URLs in Twilio match the env values **exactly** (https, no trailing slash).
- [ ] Deploy the backend first; the frontend change is independent.
- [ ] Smoke test `GET /api/v1/health`.
- [ ] Flip `WHATSAPP_SENDING_ENABLED=true` only after inbound and the signature check are verified.
- [ ] Nothing is committed to `.env.example` except empty placeholders.

## 25. Questions / Unknowns

1. Is the Twilio trial sender the **WhatsApp Sandbox** (shared number, join keyword)? I've assumed it is.
2. Is the Meta webhook currently registered in a Meta App dashboard and receiving traffic? Should it stay live during the trial?
3. Does the production `messages` collection contain any documents? (Code never writes any, so it should be empty.)
4. Is the backend GitHub repository public or private, and has it ever been public? This affects how urgent S1 is and whether history should be purged.
5. Render plan: free (sleeps) or paid? Which Node version is Render using?
6. Should inbound WhatsApp messages appear in the CRM UI during the trial, or is a backend-only log enough for now?
7. Who is allowed to trigger sends: admin only (current campaign policy), or staff for 1:1 messages too?
8. Should full message bodies be stored, given the PHI concerns in §20?
9. Is the campaign frontend envelope bug (§9) visible in the deployed CRM, or does the deployed build differ from this checkout?
10. Preferred handling of STOP / opt-out replies?

---

## Phase 10: Twilio SDK / Dependencies

- `twilio` is **not installed** (not in `backend/package.json`, 0 matches in `backend/package-lock.json`).
- `engines.node: ">=18.0.0"`; the local Node is v24.12.0. Render's version is not pinned in the repo.
- `axios` ^1.7.9 is already a dependency (the lockfile resolves 1.19.0). No `fetch` usage. CommonJS project.
- The current `twilio` SDK (v5) is CommonJS-compatible, supports Node ≥14, and depends on `axios`, `jsonwebtoken`, `qs`, `dayjs`, `scmp`, `xmlbuilder` and `https-proxy-agent`. Two of those (`axios`, `jsonwebtoken`) are already here, so **no conflicts are expected**. Verify with `npm ls` after installing.

**Recommendation: use the official `twilio` SDK.**
- `twilio.validateRequest(authToken, signature, url, params)` gives correct, constant-time (`scmp`) webhook signature validation. That is the most security-critical part of this migration, and the SDK handles the edge cases (param sorting, URL ports/query strings, JSON `bodySHA256`).
- `client.messages.create({...})` handles form encoding, basic auth, `ContentVariables` serialization and typed `RestException` errors (`code`, `status`, `moreInfo`).
- A direct REST call through the existing `axios` would also work and adds no dependency. However, it means hand-rolling the HMAC-SHA1 signature check, and that is exactly where subtle bugs become spoofing holes. The SDK's install footprint is a reasonable trade.
- Initialise the client lazily (only when the Twilio vars are present) so a missing config never crashes startup.

---

## Compact File Action Table

| File | Current Purpose | Action | Required Change | Risk |
|------|-----------------|--------|-----------------|------|
| `backend/.env.example` | Env docs; **contains real secrets** | MODIFY | Replace values with placeholders, add Twilio vars, rotate secrets | CRITICAL (current state) |
| `backend/src/config/env.js` | Central env | MODIFY | Add optional `TWILIO_*`, `WHATSAPP_PROVIDER`, allowlist | Low |
| `backend/src/models/Message.js` | Outbound message row (unused) | MODIFY | Add provider/direction/from/body/errorCode/queuedAt/failedAt/providerStatus/metadata, enum `queued`/`received`, unique index | Low |
| `backend/src/routes/whatsapp.routes.js` | Meta webhook routes | MODIFY | Add `/twilio/webhook`, `/twilio/status`, `/test-send` | Low |
| `backend/src/controllers/whatsapp.controller.js` | Meta webhook handlers | MODIFY (or NEW sibling) | Twilio handlers: TwiML ack / 204 | Low |
| `backend/src/services/whatsapp.service.js` | Meta sender + config status | MODIFY | Provider-aware `validateConfiguration()` | Low |
| `backend/src/services/twilioWhatsapp.service.js` | — | NEW | Guarded outbound send, row-before-send | Medium |
| `backend/src/services/twilioWebhook.service.js` | — | NEW | Signature validation, status guard, inbound upsert | Medium |
| `backend/src/validators/whatsapp.validator.js` | — | NEW | Zod for test-send | Low |
| `backend/src/utils/whatsappAddress.js` | — | NEW | E.164 / `whatsapp:` conversion | Low |
| `backend/package.json` | Deps | MODIFY | Add `twilio` | Low |
| `frontend/src/services/campaign.service.ts` | Campaign API client (envelope bug) | MODIFY | Unwrap `data`/`pagination` | Low |
| `backend/src/services/whatsappWebhook.service.js` | Meta webhook processing | REMOVE LATER | — | Low |
| `backend/src/app.js` | App wiring, Meta sanitize exemption | KEEP (REMOVE LATER: exemption) | None for the trial | Low |
| `backend/src/models/WhatsappTemplate.js` | Template store | KEEP (MODIFY later) | Add `twilioContentSid` later | Low |
| `backend/src/validators/whatsappTemplate.validator.js` | Template validation | KEEP (MODIFY later) | Add `twilioContentSid` later | Low |
| `backend/src/controllers/campaign.controller.js` | Draft CRUD | KEEP (MODIFY later) | Validator + send engine later | Medium (later) |
| `backend/src/models/Campaign.js` | Campaign schema | KEEP | — | Low |
| `backend/src/services/settings.service.js` | WhatsApp status for Settings | KEEP | — | Low |
| `backend/src/models/Customer.js` | Customer, consent | KEEP | — | Low |
| `backend/src/utils/normalizePhone.js` | 10-digit normalization | KEEP | — | Low |
| `frontend/src/components/campaigns/WhatsappConfigCard.tsx` | Config status UI | KEEP | — | Low |
| `frontend/src/pages/settings/Settings.tsx` | WhatsApp config tab | KEEP | — | Low |
| `frontend/src/components/campaigns/CampaignForm/CampaignForm.tsx` | Draft wizard | KEEP (MODIFY later) | "Meta" copy, template picker later | Low |
| `frontend/src/components/campaigns/MessagePreview/MessagePreview.tsx` | Static preview | KEEP (MODIFY later) | "Meta" copy | Low |
| `frontend/src/pages/campaigns/CampaignDetails.tsx` | Detail + disabled Send | KEEP (MODIFY later) | Wire Send when the engine exists | Low |

---

## Minimum Safe Implementation Plan

The smallest change set that makes **Twilio Trial work end-to-end** without touching campaigns or removing Meta:

1. **Pre-requisite (security):** rotate the S1 credentials and blank out `backend/.env.example` values.
2. `backend/src/config/env.js`: add the optional Twilio vars, `WHATSAPP_PROVIDER` and `WHATSAPP_TEST_ALLOWLIST`.
3. `backend/src/models/Message.js`: additive fields, enum values and the partial unique index.
4. **NEW** `backend/src/utils/whatsappAddress.js`: `whatsapp:+91…` ↔ 10-digit.
5. **NEW** `backend/src/services/twilioWhatsapp.service.js`: `sendText({ to, body, customerId })` with guards (kill switch, provider, config, allowlist, phone validity), row-before-send and a `StatusCallback`.
6. **NEW** `backend/src/services/twilioWebhook.service.js`: `validateSignature()` against the env URLs plus the AccountSid check; `handleStatus()` with the forward-only guard; `handleInbound()` with an idempotent upsert and customer lookup.
7. `backend/src/routes/whatsapp.routes.js` + `backend/src/controllers/whatsapp.controller.js` (+ **NEW** `backend/src/validators/whatsapp.validator.js`): `POST /twilio/webhook`, `POST /twilio/status` (public, `webhookLimiter`) and `POST /test-send` (admin + Zod + a small limiter).
8. `backend/src/services/whatsapp.service.js`: provider-aware `validateConfiguration()`, so the existing Settings UI shows Twilio readiness with no frontend change.
9. `backend/package.json`: add `twilio`.
10. *(Optional but recommended)* `frontend/src/services/campaign.service.ts`: envelope unwrap.

Untouched: `app.js`, all Meta code, campaigns, templates and all other modules. Testing uses an admin JWT with Postman/curl for `/test-send`, the tester's phone for inbound, and MongoDB Atlas plus the Twilio Console debugger for verification.

---

*Path verification: every file path cited in this report was checked against the repository after writing (see the audit session). Paths marked **NEW** do not exist yet by design.*
