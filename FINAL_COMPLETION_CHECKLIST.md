# Nakul Pathology CRM — Final Completion Checklist

Last updated: 2026-11-17 (project closure). Statuses: PASS / FAIL / BLOCKED / NOT TESTED.
Nothing below is marked done without evidence. Owner confirmations are labelled as such.
Development is closed: no new features. The remaining items are owner dashboard actions and
approval-required steps (§3, §5).

**MSG91 workflow completion pass (2026-11-17):** full audit of outbound send, request-id
storage, delivery/read/failed tracking, inbound replies, customer matching, conversations,
duplicate protection and Twilio separation. No defects found → no application code changed.
Added `backend/tests/msg91Completion.http.test.js` (8 tests, pass) for the cases not yet
pinned explicitly; created `MSG91_FINAL_SETUP_GUIDE.md`. Results: FINAL_RELEASE_REPORT.md §2.

| Workflow step | Code + mocked tests | Real production evidence |
|---|---|---|
| CRM sends template via MSG91; row stored; request id stored | PASS | NOT TESTED |
| Delivery / read webhook updates the same row | PASS | NOT TESTED |
| Failed message shows failed + reason | PASS | NOT TESTED |
| Customer reply → inbound webhook → matched customer → conversation | PASS | **PASS** (2026-11-16) |
| Duplicate webhook events create no duplicates | PASS | NOT TESTED (no duplicate observed) |
| Twilio and MSG91 history distinguishable | PASS | PASS (provider column; owner-observed history intact) |

---

## 1. Run the project locally (VS Code)

Two terminals. The backend uses an **in-memory MongoDB** and never loads `backend/.env`
(production values), so nothing local can touch the production database, and WhatsApp
sending and campaigns are forced OFF.

**Terminal 1 — backend (API on http://localhost:5055/api/v1)**

```powershell
cd "C:\Users\Hp 440 G7\OneDrive\Desktop\nakul-pathology-crm\backend"
npm run dev:memory
```

Wait for `[dev:memory] API  http://localhost:5055/api/v1`.

**Terminal 2 — frontend (http://localhost:3000, or 3001 if 3000 is busy)**

```powershell
cd "C:\Users\Hp 440 G7\OneDrive\Desktop\nakul-pathology-crm\frontend"
npm run dev
```

Open the `Local:` URL Vite prints. Log in as `devadmin@dev.local` (admin) or
`staff@dev.local` (staff); passwords are in the git-ignored `backend/.env.devadmin.local`.

Notes
- Do **not** use `npm run dev` / `npm start` in `backend/` for local work: they load
  `backend/.env`, which points at the production Atlas database and listens on a port
  other than 5055 (the frontend would show "Unable to reach the server").
- Data is in memory: it resets every time the backend restarts.
- Only one backend may hold port 5055. If startup says `EADDRINUSE 127.0.0.1:5055`, another
  backend is still running — stop it (Ctrl+C in its terminal) first.
- File uploads (reports/prescriptions) need Cloudinary and are disabled in this mode.

---

## 2. Local functional status (verified 2026-11-16, isolated stack)

| # | Acceptance item | Status | Evidence |
|---|---|---|---|
| 1 | Backend starts | PASS | `dev:memory` on 5055, health 200, database connected |
| 2 | Frontend starts | PASS | Vite on 3000 and on 3001 |
| 3 | Frontend reaches backend | PASS | browser QA on localhost:3001 and :3000, 0 failed API calls |
| 4 | API health check | PASS | `GET /api/v1/health` 200 |
| 5 | Login / logout | PASS | browser + API |
| 6 | Session survives refresh | PASS | reload on /leads stays logged in |
| 7 | Dashboard | PASS | page + `/dashboard/stats` 200 |
| 8 | Customers | PASS | create, edit, search, details, duplicate mobile → 409, import page loads |
| 9 | Leads | PASS | create, edit status, filter, details, delete (admin) |
| 10 | Assigned To picker | PASS | `/auth/users/assignable` 200, lead saved with assignee |
| 11 | Follow-ups | PASS | create, complete, summary |
| 12 | Appointments and tests | PASS | tests and packages create/edit; appointments create/edit/list/delete |
| 13 | Reports and prescriptions | PASS (list) / BLOCKED (upload) | pages and lists load; upload needs Cloudinary credentials |
| 14 | WhatsApp settings and history | PASS | settings, MSG91 status, messages, conversations, reports load; nothing sent |
| 15 | Existing tests | PASS | see §3 |
| 16 | TypeScript and builds | PASS | tsc 0 errors, vite build OK |
| 17 | No critical console/runtime errors | PASS | 0 console errors on all 17 pages |

Security checks done locally: no token → 401, invalid token → 401, staff cannot delete
leads or create users (403), no password fields in login/assignable responses, MSG91 webhook
without secret is refused.

---

## 3. Production closure status (2026-11-17)

Production runs backend `e982d83` and frontend `cd0ef57` (unchanged in this closure; nothing
deployed, pushed or reconfigured). "Owner" = confirmed by the account owner, not by me.

### 3a. WhatsApp (MSG91)

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | `MSG91_WEBHOOK_SECRET` set on Render | PASS | 2026-11-17 live: inbound and status webhooks → 401 without / with a wrong secret (was 503 before 2026-11-16) |
| 2 | MSG91 inbound webhook configured and reaching production | PASS | real event 2026-11-16 (owner-observed, below) |
| 3 | **Real inbound message in production** | **PASS** | owner: real WhatsApp from the test number reached production, secret check passed, stored once, matched to the correct customer, shown in Conversations; no synthetic event, nothing sent |
| 4 | Twilio message history preserved, providers distinguishable | PASS | no migration touches existing rows; every message row carries `provider` (`twilio` / `msg91` / `meta`); unique index is per `(provider, messageId)` |
| 5 | MSG91 status (delivery report) webhook configured | NOT TESTED | URL is protected (401 for wrong secret); no real delivery event has reached production yet |
| 6 | **Real outbound send + delivery event from production** | NOT TESTED | needs the controlled test in §5 (approval required) |
| 7 | `WHATSAPP_PROVIDER=msg91` | NOT TESTED (owner: MSG91, 2026-11-16) | needs admin login (`GET /whatsapp/msg91/config`) or Render; not readable anonymously |
| 8 | `WHATSAPP_SENDING_ENABLED=false` | NOT TESTED (owner: OFF, 2026-11-15) | not re-confirmed after the 2026-11-16 Render changes |
| 9 | `WHATSAPP_CAMPAIGNS_ENABLED=false` | NOT TESTED (owner: OFF, 2026-11-15) | same |
| 10 | Campaign worker OFF | NOT TESTED | worker starts only if item 9 is true; Render logs must show `Campaign worker not started (WHATSAPP_CAMPAIGNS_ENABLED is not true).` |

### 3b. Security (owner dashboard actions)

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Rotate `JWT_SECRET` | BLOCKED (owner) | not confirmed. On 2026-11-15 production still accepted a token signed with the leaked secret; not re-tested (owner forbade using it) |
| 2 | Rotate `COOKIE_SECRET` independently | BLOCKED (owner) | not confirmed |
| 3 | Rotate MongoDB Atlas DB user/password | BLOCKED (owner) | not confirmed |
| 4 | Rotate Cloudinary API key/secret | BLOCKED (owner) | not confirmed |
| 5 | Change production admin password, review unknown users | BLOCKED (owner) | not confirmed |
| 6 | Remove `SEED_ADMIN_*` from Render | BLOCKED (owner) | not confirmed |
| 7 | Git history exposure (backend commit `46e8274`) | FAIL | still in history (repos private). Rotation (1–6) neutralises it; history rewrite needs separate approval |
| 8 | Production CORS restricted | PASS | 2026-11-17 live: CRM origin 204, `http://localhost:3000` 403 (full matrix 45/45 on 2026-11-16) |

### 3c. Database

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Atlas backup enabled + recent snapshot | BLOCKED (owner) | owner said "done" (2026-11-15) but gave no snapshot time/policy — unverified |
| 2 | Restore into a separate target, counts compared | BLOCKED (owner) | owner said "done" but gave no target name or document counts — unverified. No production restore was or will be performed by me |

---

## 4. CORS policy (backend `c921f60`)

- Credentialed CORS, all routes: `https://crm.nakulpathologylab.in` only (plus
  `CLIENT_URL`/`CRM_URL` on Render if they are https).
- Public website (nakulpathologylab.in, www, Netlify): `/api/v1/public/*` only, without
  credentials — its `js/api.js` calls only those routes.
- localhost origins (3000/3001/5173/4173/5500): development only.
- Everything else (unknown, `null`, http, look-alike, the `*.vercel.app` CRM domain): 403.
- Test: `backend/tests/corsOrigins.unit.test.js` (5 cases; all fail on the old code).

---

## 5. One controlled production outbound test (approval required — NOT done)

Code is ready (FINAL_RELEASE_REPORT.md §3). Variable names, webhook URLs and header:
`MSG91_FINAL_SETUP_GUIDE.md`. What is still needed, in order:

1. **Decision (owner):** the activation gate says rotate the leaked credentials (§3b 1–6)
   first. Running this test before rotation is an explicit owner exception.
2. **Approval (owner):** exactly one recipient (must be the single allowlisted test number),
   template `testing` (en, UTILITY, 4 body variables) and the 4 variable values.
3. **MSG91 dashboard (owner):** the status webhook (*On Outbound Report Received*) points to
   `https://api.nakulpathologylab.in/api/v1/whatsapp/msg91/status`, POST JSON, header
   `X-Webhook-Secret` = the Render value, and is not paused.
4. **Render (owner), one save:** `WHATSAPP_TEST_ALLOWLIST` = only the test number;
   `WHATSAPP_RESTRICT_TO_ALLOWLIST` unset or `true`; `WHATSAPP_CAMPAIGNS_ENABLED=false`;
   `WHATSAPP_SENDING_ENABLED=true` (temporary). Wait for the deploy; health = `connected`.
5. **CRM (admin):** Settings → MSG91 shows provider MSG91, configured, template `testing`
   sendable (approved, not disabled). Send **one** test message from Settings → MSG91 test send.
6. **Evidence to record:** message row `provider: msg91`, `status: queued`,
   `providerRequestId` set (never shown as sent before MSG91 reports it); then the real status
   webhook moves it to sent → delivered (→ read) with timestamps; Settings "last delivered"
   updates; Render log `MSG91 status: "delivered" for request … → updated`.
   (`?refresh=true` reads MSG91 logs but does **not** prove the webhook.)
7. **Immediately after (owner):** `WHATSAPP_SENDING_ENABLED=false` on Render, redeploy,
   confirm Settings shows sending OFF and campaigns OFF.

Pass = items 6 all observed. If no status event arrives within ~10 minutes, check the
MSG91 webhook log/paused state before anything else — do not send a second message.

## 6. Approval-required actions (nothing here has been done)

- Any real outbound message (§5), enabling production sending, enabling campaigns.
- Any Render / Vercel / Atlas / Cloudinary / MSG91 configuration change.
- Any push or deploy; rewriting backend Git history.
- Any production restore.
