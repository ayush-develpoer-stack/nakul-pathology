# Nakul Pathology CRM — Final Project Closure Report

Date: 2026-11-17 (UTC; IST = UTC+5:30). Statuses: PASS / FAIL / BLOCKED / NOT TESTED.
Supersedes the status sections of FINAL_RELEASE_REPORT.md, FINAL_COMPLETION_CHECKLIST.md and
FINAL_DEPLOYMENT_VERIFICATION.md (those remain as history). FINAL_OWNER_ACTION_PLAN.md does
not exist; the owner checklist is §16 here. Setup details: MSG91_FINAL_SETUP_GUIDE.md.

In this closure: **no code defect found → no code change, no commit, no deploy.** No message
sent, no production setting or data changed, no secret printed or written.

---

## 1. Overall completion

Calculated over 28 clearly defined tasks (table in §17). Only PASS counts as done.

| Group | Tasks | PASS |
|---|---|---|
| A. Code, tests, local environment | 6 | 6 |
| B. Deployment and production checks | 5 | 4 |
| C. WhatsApp / MSG91 | 7 | 4 |
| D. Security rotation and exposure | 7 | 0 |
| E. Backup and restore | 2 | 0 |
| F. Production file uploads | 1 | 0 |
| **Total** | **28** | **14 → 50 %** |

Code-side work (A, plus everything verifiable without dashboard access) is complete. Every
remaining task needs owner dashboard access or owner-side evidence (§16).

## 2. Production deployment

| Item | Value | Status |
|---|---|---|
| Backend | `f5e9d52` on `main` = GitHub `origin/main`; `/health` → `production`, `database connected`, `commit f5e9d52` | PASS |
| Frontend | `cd0ef57` on `main` = GitHub `origin/main`; live bundle `index-CBCvhybZ.js` | PASS |
| Working trees | both clean, in sync with `origin/main` | PASS |

## 3. Local environment

| Check | Status |
|---|---|
| Backend `npm run dev:memory` on 5055 (in-memory MongoDB, never reads `backend/.env`) — health 200 | PASS |
| Frontend `npm run dev` on 3000 — 200, `VITE_API_URL=http://localhost:5055/api/v1` | PASS |
| The earlier production-connected local backend (`npm run dev`, port 5000) | PASS — no longer running (no port 5000 listener, no Atlas connections) |
| Local API smoke (scratchpad `local-smoke.js`): health, invalid login 401, no-session 401, admin login, no password in response, session `/auth/me`, 19 list pages (dashboard, customers, leads, follow-ups + summary, tests, packages, appointments, reports, prescriptions, activities, campaigns, WhatsApp templates/messages/conversations/MSG91 config, settings profile/business, assignable users), create/edit/details customer, duplicate mobile 409, create lead/test/package/appointment/follow-up, WhatsApp send refused while sending is off, logout, 401 after logout | **37/37 PASS** |
| Report/prescription **file upload** locally | BLOCKED by design (Cloudinary credentials are not given to the isolated backend) |

## 4. Tests (all commands completed)

| Suite | Result | vs previous | Status |
|---|---|---|---|
| Backend `npm test` (incl. auth/RBAC, MSG91, in-memory DB integration) | 458/458, 113 suites | same | PASS |
| Frontend unit | 38/38 | same | PASS |
| Frontend UI (vitest) | 185/185, 23 files | same | PASS |
| Frontend lint (oxlint) | exit 0 — 0 errors, 75 pre-existing warnings | same | PASS |
| TypeScript + production build (`tsc -b && vite build`) | exit 0 | same | PASS |
| Backend lint | not configured | — | NOT TESTED |

Count note: one UI run executed **in parallel with the backend suite** reported 19 files /
149 tests, all passing, no failures. Two later runs on their own reported 23/185 each; no test
file changed (`git status` clean). The reduced count is attributed to resource contention
during the parallel run; the authoritative result is 23/185.

## 5. Authentication

| Check | Status |
|---|---|
| `JWT_SECRET` and `COOKIE_SECRET` read independently (`env.js`; JWT → `generateToken.js`, COOKIE → `cookie-parser` in `app.js`) | PASS |
| Both required in production (fatal start if missing or < 32 chars); no hardcoded fallback (dev-only COOKIE fallback is random per process) | PASS |
| Not enforced: JWT and COOKIE values being **different** — owner must ensure it (§16 S2) | NOTE |
| Production: no token / garbage token / invalid credentials → 401 / 401 / 401 | PASS |
| Local: login, session, logout, RBAC (backend tests + smoke) | PASS |

## 6. MSG91 outbound — the owner's production send (2026-11-17)

Evidence source: MSG91 WhatsApp logs API, **read-only**, with the local key file; numbers
masked. No message was sent or retried by me.

| Field (MSG91 log) | Value |
|---|---|
| Direction / template | outbound / `testing` |
| Recipient / sender | XXXXXX5157 / XXXXXX4729 |
| Request id | `b5862b32…` |
| Requested | 2026-11-17 20:30:59 IST (15:00:59 UTC) |
| Sent / Delivered | 20:31:13 IST |
| Read | 20:31:23 IST |
| Failure | none |

| Verification item | Status |
|---|---|
| MSG91 accepted, delivered and the recipient read the message | **PASS** (provider logs) |
| CRM message row exists, provider `msg91`, request id `b5862b32…` stored | NOT TESTED — needs admin view of production (owner, §16 W1) |
| Initial status Queued (never shown as Sent before MSG91 reports it) | PASS in code/tests; production row NOT TESTED |
| **Real status webhook updated the same row** (Sent → Delivered → Read + timestamps) | NOT TESTED — owner evidence needed (§16 W1) |
| Failure details stored | NOT TESTED (no failure occurred; code/tests PASS) |
| Duplicate status events handled safely | PASS in code/tests; not observable in production |

## 7. Delivered / Read / Failed tracking

Code and automated tests: PASS (forward-only, duplicate/late events ignored, failure code +
reason stored, unknown ids ignored, never touches Twilio rows). Real production webhook
evidence: **NOT TESTED** until the owner confirms the CRM row of §6 shows Read with timestamps.

## 8. Inbound webhook

| Check | Status |
|---|---|
| Production inbound + status webhooks: missing secret 401, wrong secret 401 | PASS |
| Real inbound in production 2026-11-16 (stored once, correct customer, visible in Conversations) | PASS (owner-observed) |
| MSG91 logs show a second inbound from XXXXXX5157 at 2026-11-17 20:34:42 IST | provider PASS; CRM display NOT TESTED (owner) |
| MSG91 log field on inbound rows reads "no inbound setting selected" | observation only — also present on 15 Nov; it refers to MSG91's own inbox routing, while webhook delivery to the CRM was proven on 16 Nov |

## 9. Twilio cleanup recommendation

- No fallback from MSG91 to Twilio exists; Twilio code runs only when `WHATSAPP_PROVIDER=twilio`.
- Legacy Twilio rows stay in the database and remain visible (provider column / filter);
  they do not depend on any env var.
- Production `POST /whatsapp/twilio/webhook` (unsigned) → **503 "not configured"**: at least one
  of `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` or the Twilio webhook URL is already absent on
  Render, so Twilio webhooks are already inactive.

| Variable | If removed |
|---|---|
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Twilio send/test-send and Twilio webhooks stop (already inactive); Twilio Content approval lookup stops |
| `TWILIO_WHATSAPP_FROM`, `TWILIO_MESSAGING_SERVICE_SID` | Twilio sending impossible (unused with MSG91) |
| `TWILIO_STATUS_CALLBACK_URL`, `TWILIO_WEBHOOK_URL` | Twilio callbacks rejected (already) |
| `TWILIO_TEST_CONTENT_SID`, `TWILIO_WHATSAPP_SANDBOX` | Twilio test-send settings only |
| `TWILIO_WHATSAPP_NUMBER` | not read by the code at all |

**Recommendation:** the owner may remove **all** `TWILIO_*` variables from Render. MSG91
sending, inbound, status tracking and Twilio history are unaffected. Keep the Twilio code.

## 10. Security rotation checklist (owner; nothing confirmed)

| # | Item | Status |
|---|---|---|
| S1 | `JWT_SECRET` rotated | BLOCKED |
| S2 | `COOKIE_SECRET` rotated independently (different value) | BLOCKED |
| S3 | Atlas DB user rotated, Render `MONGODB_URI` updated | BLOCKED |
| S4 | Old Atlas user deleted after healthy deploy | BLOCKED |
| S5 | Cloudinary key/secret rotated, Render updated, old key disabled | BLOCKED |
| S6 | Production admin password changed; users reviewed | BLOCKED |
| S7 | `SEED_ADMIN_*` removed from Render | BLOCKED |
| S8 | No secrets in tracked files (both repos scanned), frontend bundle (0 markers), reports | PASS |
| S9 | Backend commit `46e8274` still reachable from `origin/main`; its `.env.example` has non-empty `MONGODB_URI`, `JWT_SECRET`, `COOKIE_SECRET`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `SEED_ADMIN_PASSWORD` (names checked only). Repo private (anonymous 404). | FAIL |

Risk (S9): anyone with current or past read access to the backend repository (collaborators,
forks, clones, CI integrations) can read those values. If they still match production, they
allow database access, forged login tokens (proven on 2026-11-15), Cloudinary access and admin
login. **Safest remediation: rotation S1–S7** (makes the leaked values worthless). History
rewrite (`git filter-repo` + force-push) is optional afterwards, needs explicit approval, and
does not remove copies already cloned — it never replaces rotation.

## 11. Atlas backup and restore

| Item | Status |
|---|---|
| Latest backup exists, timestamp recorded | BLOCKED (no Atlas access; owner gave no snapshot time) |
| Retention policy understood | BLOCKED |
| Restore into a separate (non-production) target | BLOCKED |
| Collections and document counts compared | BLOCKED |
| App connectivity to the restored copy tested safely | BLOCKED |

## 12. Production health (read-only, no login)

| Check | Status |
|---|---|
| `/health` 200, production, DB connected, commit `f5e9d52` | PASS |
| Frontend `/` and deep links (/login, /dashboard, /customers, /appointments, /campaigns/messages, /settings) 200 | PASS |
| Bundle uses `https://api.nakulpathologylab.in/api/v1`; no `localhost`; no secret markers | PASS |
| CORS: CRM origin 204 with credentials; localhost 403; unknown origin 403 | PASS |
| Public: `/public/tests` 200; website origin allowed on `/public/*` (204), refused elsewhere (403) | PASS |
| MSG91 webhooks reject missing/wrong secret (401) | PASS |
| Production sending/campaigns state, Settings provider row | NOT TESTED (needs admin login) |
| Logged-in production pages / browser console | NOT TESTED (last owner pass 2026-11-15) |

## 13. Files changed in this closure

| File | Change |
|---|---|
| `FINAL_PROJECT_CLOSURE_REPORT.md` | new (project root; not a Git repository) |
| Application code / tests | none |

Read-only helper scripts (not part of the project): scratchpad `msg91-logs-readonly.js`,
`local-smoke.js`.

## 14. Git

No commit and no push in this closure (no defect). Last push today: backend
`e982d83..f5e9d52` (test-only). No force-push, no history rewrite.

## 15. Render / Vercel

| Target | Status |
|---|---|
| Render runs `f5e9d52` (health) | PASS |
| Vercel serves the `cd0ef57` bundle | PASS |
| No new deployment needed | — |

## 16. Remaining owner actions (exact)

**W — Production evidence (CRM, admin login; no sending):**
1. W1: Messages page → the outbound MSG91 row from 17 Nov ~20:31 IST to …5157: confirm
   provider **MSG91**, request id starting `b5862b32`, status **Read**, with Sent/Delivered/Read
   times. If it still shows **Queued**, the status webhook did not reach the CRM → check MSG91 →
   Webhook (New) → *On Outbound Report Received* (URL `…/api/v1/whatsapp/msg91/status`, header
   `X-Webhook-Secret`, not paused). Do **not** resend.
2. W2: Conversations → the reply from …5157 at 20:34 IST appears once under the right customer.
3. W3: Messages → provider filter "Twilio" still lists the legacy Twilio messages.
4. W4: Settings → MSG91 / WhatsApp: provider MSG91, **sending OFF**, **campaigns OFF**.
   Render: `WHATSAPP_SENDING_ENABLED=false`, `WHATSAPP_CAMPAIGNS_ENABLED=false`,
   `WHATSAPP_RESTRICT_TO_ALLOWLIST=true`, `WHATSAPP_PROVIDER=msg91`; Render log shows
   `Campaign worker not started`.

**S — Security (Render, Atlas, Cloudinary, CRM; generate values locally, never paste in chat):**
1. Render: new `JWT_SECRET` (48+ random bytes). Effect: everyone is logged out.
2. Render: new **different** `COOKIE_SECRET`.
3. Atlas → Database Access: new DB user (readWrite on the CRM database only), new password.
4. Render: update `MONGODB_URI` with the new user → deploy → `/health` = connected.
5. Atlas: delete the old DB user only after step 4 is healthy.
6. Cloudinary → API Keys: generate a new key/secret.
7. Render: update `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` → deploy → upload one test report.
8. Cloudinary: disable/delete the old key.
9. CRM: change the production admin password.
10. CRM → Users: review every account; remove only those you confirm are unauthorized.
11. Render: delete `SEED_ADMIN_NAME`, `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PHONE`,
    `SEED_ADMIN_PASSWORD` after confirming the real admin login works.
12. Tell me "rotation done" (no values): I re-run the read-only checks (bundle, tracked files,
    health, auth).

**B — Backup (Atlas):**
1. Cluster → Backup: confirm Cloud Backup is ON; note the latest snapshot time and retention.
2. Restore that snapshot to a **separate** cluster/database (never "restore to this cluster"
   over production), e.g. a new free/test cluster.
3. Compare collection names and document counts (Atlas Data Explorer) with production.
4. Optional: point a local `dev` backend at the restored copy only (never production).
5. Share: snapshot time, retention, restore target name, counts — no credentials.

**Optional cleanup:**
- Render: remove all `TWILIO_*` (§9).
- Uploads: after S7, upload one report and one prescription in production.
- MSG91 campaigns: create a MARKETING template and get it approved before any campaign
  (MSG91_FINAL_SETUP_GUIDE.md §6). Campaigns stay OFF until then.
- Git history rewrite of `46e8274` (separate approval; after rotation).

## 17. Task table and blockers

| # | Task | Status |
|---|---|---|
| A1 | CRM modules implemented, local smoke 37/37 | PASS |
| A2 | Backend suite 458/458 | PASS |
| A3 | Frontend unit 38/38 + UI 185/185 | PASS |
| A4 | Lint, TypeScript, production build | PASS |
| A5 | Authentication / RBAC (code + local) | PASS |
| A6 | Isolated local environment (5055 + 3000) | PASS |
| B1 | Correct commits deployed, health OK | PASS |
| B2 | Frontend bundle → production API, no localhost/secrets | PASS |
| B3 | Production CORS | PASS |
| B4 | Production auth rejections | PASS |
| B5 | Logged-in production QA (owner) | NOT TESTED |
| C1 | MSG91 webhook authentication | PASS |
| C2 | Real inbound in production | PASS |
| C3 | Real outbound accepted/delivered/read (MSG91 logs) | PASS |
| C4 | CRM row updated by real status webhook | NOT TESTED |
| C5 | Safe production flags (provider, sending OFF, campaigns OFF, restrict) | NOT TESTED |
| C6 | Twilio audit + cleanup recommendation | PASS |
| C7 | Marketing campaigns ready | BLOCKED (no approved MARKETING template) |
| D1–D6 | JWT, COOKIE, Atlas, Cloudinary, admin password/users, `SEED_ADMIN_*` | BLOCKED (6) |
| D7 | Git history exposure `46e8274` | FAIL |
| E1 | Atlas backup verified | BLOCKED |
| E2 | Restore to separate target verified | BLOCKED |
| F1 | Production report/prescription upload | NOT TESTED |

**Genuine blockers:** credential rotation (D1–D6) — the leaked values may still be valid;
backup/restore evidence (E1–E2). No code blockers.
