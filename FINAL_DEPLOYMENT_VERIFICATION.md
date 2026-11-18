# Nakul Pathology CRM — Final Deployment Verification

Date: 2026-11-17 (UTC). Statuses: PASS / FAIL / BLOCKED / NOT TESTED.
No secret values were printed, copied or written anywhere. No production settings, data,
Render/Vercel/Atlas/Cloudinary/MSG91 configuration were changed. No WhatsApp message sent.

---

## 1. Local login error "Unable to reach the server" — root cause

| Finding | Status |
|---|---|
| **Root cause:** the local backend had been started with plain `npm run dev` in `backend/`. That loads `backend/.env` (production values): it listened on **port 5000** and held open connections to a **remote MongoDB (Atlas, port 27017)**. The frontend's `frontend/.env` correctly points to `http://localhost:5055/api/v1`, where nothing was listening → every request failed → "Unable to reach the server". | identified |
| Not a code defect: `VITE_API_URL`, the `/api/v1` prefix, CORS for `http://localhost:3000` (dev only) and the login flow are all correct. **No code changed.** | PASS |
| Fix applied: started the isolated backend `npm run dev:memory` on 5055 (in-memory MongoDB, never reads `backend/.env`, sending/campaigns OFF). | PASS |
| Stopping the production-connected local process (`npm run dev`, port 5000) | **BLOCKED** — my attempt was refused by the permission system. **Owner: press Ctrl+C in that terminal.** Until then a local process on this PC is connected to the production database. |
| Local health `GET localhost:5055/api/v1/health` | PASS (200, `environment development`, `database connected` = in-memory) |
| Local frontend `http://localhost:3000` | PASS (200, Vite) |
| CORS preflight from `http://localhost:3000` | PASS (204, allow-origin 3000, credentials true) |
| Invalid login → handled | PASS (401 "Invalid email or password.") |
| Valid dev-admin login reaches the backend | PASS (200; password read from the git-ignored `.env.devadmin.local`, never printed) |
| Browser-level login in the running frontend | NOT TESTED by me (API-level checks above); reload http://localhost:3000 and log in as `devadmin@dev.local` |

Correct local procedure (unchanged): FINAL_COMPLETION_CHECKLIST.md §1 — backend
`npm run dev:memory` (5055), frontend `npm run dev` (3000). Never `npm run dev` / `npm start`
in `backend/`.

## 2. Files changed

| File | Reason | Status |
|---|---|---|
| `backend/tests/msg91Completion.http.test.js` (new, 8 tests) | MSG91 workflow cases not yet pinned explicitly (from the previous pass) | committed `f5e9d52` |
| `FINAL_DEPLOYMENT_VERIFICATION.md` (this file) | requested report | local (project root is not a Git repository) |

No application code, configuration or frontend file changed.

## 3. Twilio audit

| Question | Answer |
|---|---|
| Completely unused? | **No.** |
| Active code path? | Only when `WHATSAPP_PROVIDER=twilio` (send/reply/test-send/campaign worker select Twilio). With `msg91` active, Twilio is never called (test: "Twilio is never used while MSG91 is active"). |
| Fallback when MSG91 fails? | **No.** There is no provider fallback anywhere. |
| Legacy use | Existing Twilio rows (`provider: "twilio"`) are shown in Messages/Conversations with Twilio error hints; Twilio campaigns stay Twilio-only. Stored in the database, independent of env vars. |
| Twilio webhooks | `POST /whatsapp/twilio/webhook` and `/twilio/status` still exist, signature-checked with `TWILIO_AUTH_TOKEN`; without `TWILIO_AUTH_TOKEN`/`TWILIO_ACCOUNT_SID` they reject every request (`not_configured`). |

Env names the code reads (all in `backend/src/config/env.js`; used in
`twilioWhatsapp.service.js`, `twilioWebhook.service.js`):
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`,
`TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_STATUS_CALLBACK_URL`, `TWILIO_WEBHOOK_URL`,
`TWILIO_TEST_CONTENT_SID`, `TWILIO_WHATSAPP_SANDBOX`. `TWILIO_WHATSAPP_NUMBER` is **not read**
by the code. SDK: `twilio` (npm) in `twilioWhatsapp.service.js` / `twilioWebhook.service.js`.

**Recommendation:** keep the Twilio code (selectable provider, legacy display, tested).
With `WHATSAPP_PROVIDER=msg91`, the owner **may safely remove all `TWILIO_*` variables from
Render** (including any `TWILIO_WHATSAPP_NUMBER`): sending is unaffected, Twilio history stays
in the database, and Twilio webhooks will then reject all calls. Removing the Twilio auth
token also reduces credential exposure. Not done by me — owner decision.

## 4. MSG91 configuration (names only)

All of `WHATSAPP_PROVIDER`, `MSG91_AUTH_KEY`, `MSG91_WHATSAPP_NUMBER`, `MSG91_WEBHOOK_SECRET`,
`WHATSAPP_TEST_ALLOWLIST`, `WHATSAPP_RESTRICT_TO_ALLOWLIST`, `WHATSAPP_SENDING_ENABLED`,
`WHATSAPP_CAMPAIGNS_ENABLED` are read by `env.js` and validated (MSG91 config check reports
missing/invalid names only). Details and the readiness table: MSG91_FINAL_SETUP_GUIDE.md §1, §5.

| Production state | Status |
|---|---|
| `MSG91_WEBHOOK_SECRET` set (webhooks 401, not 503) | PASS |
| Inbound + status webhooks reject missing/wrong secret | PASS (401/401 each, after the new deploy — §10) |
| `WHATSAPP_PROVIDER=msg91`, `RESTRICT_TO_ALLOWLIST` on, sending OFF, campaigns OFF | NOT TESTED (needs admin login/Render; owner-confirmed earlier) |

## 5. Security checks

| Check | Status |
|---|---|
| `JWT_SECRET` and `COOKIE_SECRET` read independently (no cross-fallback; COOKIE dev fallback is a random per-process value; production requires both ≥ 32 chars) | PASS |
| No secret hardcoded in source; no secret values logged (only variable names) | PASS |
| `.env`, `.env.msg91.local`, `.env.*.local` git-ignored in backend; `.env` in frontend; only `.env.example` tracked | PASS |
| Commit `f5e9d52` contains only fake fixtures (scanned) | PASS |
| No production credentials added to local files | PASS |
| Git history exposure (backend commit `46e8274`) | FAIL — still present; no rewrite/force-push (needs separate approval) |
| Credential rotation (JWT, COOKIE, Atlas, Cloudinary, admin password, `SEED_ADMIN_*`) | BLOCKED (owner) |
| A local process ran against production (§1) | BLOCKED (owner must stop it) |

## 6. Backend tests

| Check | Result | Status |
|---|---|---|
| Full suite `npm test` (includes MSG91, auth/RBAC, in-memory DB integration) | 458/458, 0 fail (113 suites) | PASS |
| Backend lint | no linter configured | NOT TESTED |

## 7. Frontend tests and build

| Check | Result | Status |
|---|---|---|
| Unit (`npm run test:unit`) | 38/38 | PASS |
| UI (`npm run test:ui`) | 185/185 (23 files) | PASS |
| Lint (`oxlint`) | exit 0 — 0 errors, 75 pre-existing warnings | PASS |
| TypeScript + production build (`npm run build`) | exit 0 | PASS |

## 8. Git

| Repo | Branch | Commit | Status |
|---|---|---|---|
| backend `nakul-pathology-crm-backend` | `main` → `origin/main` | `e982d83..f5e9d52` (normal push, no force); GitHub `main` = `f5e9d52` | PASS |
| frontend `nakul-pathology-crm-frontend` | `main` | unchanged `cd0ef57` (nothing to commit) | PASS |

## 9. Deployments

| Target | Result | Status |
|---|---|---|
| Render (backend) | auto-deployed `f5e9d52`; `/health` reports `commit f5e9d52` at 14:55:57 UTC (dashboard deploy log not viewed — no Render access) | PASS |
| Vercel (frontend) | no new commit → no deploy needed; live bundle `index-CBCvhybZ.js` (= `cd0ef57`) | PASS |

## 10. Production health (read-only, no login)

| Check | Result | Status |
|---|---|---|
| API `/health` | 200, `production`, `database connected`, `commit f5e9d52` | PASS |
| Frontend `https://crm.nakulpathologylab.in/` + deep links (/login, /dashboard, /customers, /campaigns/messages, /settings) | 200 | PASS |
| Frontend uses the production API | bundle contains `https://api.nakulpathologylab.in/api/v1`, no `localhost:5055` | PASS |
| MSG91 inbound / status webhooks, missing and wrong secret | 401 / 401 each | PASS |
| Auth: no token, garbage token, invalid login | 401, 401, 401 | PASS |
| CORS: CRM origin with credentials / localhost:3000 / unknown origin | 204 / 403 / 403 | PASS |
| Public website endpoint `/public/tests` | 200 | PASS |
| Browser console / logged-in pages | NOT TESTED (no production login; last owner-guided pass 2026-11-15 OK) | NOT TESTED |

## 11. Remaining blockers

1. **Owner, now:** stop the local `npm run dev` backend (port 5000, connected to production
   Atlas) — Ctrl+C in its terminal.
2. Credential rotation (JWT, COOKIE, Atlas user, Cloudinary, admin password, remove
   `SEED_ADMIN_*`) — not confirmed. The Atlas password also appears in your local
   `backend/.env`; treat any copy of it shared anywhere as exposed.
3. Atlas backup + separate-target restore evidence.
4. Confirm in Settings: provider MSG91, sending OFF, campaigns OFF.
5. Optional: remove `TWILIO_*` from Render (§3).
6. One approved MSG91 outbound test (MSG91_FINAL_SETUP_GUIDE.md §4); no Marketing template yet.
