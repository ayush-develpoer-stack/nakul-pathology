# Nakul Pathology CRM — Final Release Report (project closure)

Date: 2026-11-17 (UTC). Statuses: PASS / FAIL / BLOCKED / NOT TESTED.
Previous version (2026-11-16) is superseded; its release details are summarised in §1.

**Overall:** the CRM is built, deployed and working in production, and the first real
MSG91 inbound WhatsApp message has been processed end-to-end in production. Development is
closed — no features were added in this closure. The project is **not security-complete**:
leaked credentials are still unrotated, and production outbound WhatsApp has not been
tested. Production sending and campaigns must stay OFF until the owner closes §6.

In this closure: no application code changes, no deploys, no pushes, no messages sent, no
production settings or data changed. Only read-only production checks were run.

**MSG91 workflow completion audit (2026-11-17, second pass).** Every part of the
send → store → request id → delivery/read/failed → reply → inbound → customer match →
conversation chain was inspected (services, webhook handlers, Message model and indexes,
history/conversation APIs, Messages/Conversation pages, status labels, Settings/Reports) and
mapped to tests (§2a). **No genuine defect was found, so no application code was changed.**
The cases that were not yet pinned by an explicit test got one new file,
`backend/tests/msg91Completion.http.test.js` (8 tests, all pass on the existing code).
New: `MSG91_FINAL_SETUP_GUIDE.md` (Render variable names, webhook URLs, header, templates).
Files changed in total: that test file, this report, FINAL_COMPLETION_CHECKLIST.md and the
new guide — all local and uncommitted.

---

## 1. Completed code (in production)

| Item | Value | Status |
|---|---|---|
| Backend deployed commit | `e982d83` on `main` (live `/health` 2026-11-17: `environment production`, `database connected`, `commit e982d83`) | PASS |
| Frontend deployed commit | `cd0ef57` on `main` (Vercel) | PASS |
| Local working trees | backend and frontend clean, equal to the deployed commits | PASS |
| CRM modules: auth, dashboard, customers, leads + Assigned To, follow-ups, appointments, tests/packages, reports/prescriptions, users/permissions, settings, activities | implemented | PASS |
| MSG91 provider: template send, session reply (24 h window), inbound webhook, status webhook, logs refresh, admin config/templates/test-send | implemented | PASS |
| Campaigns: approved Marketing templates only, consent/opt-out, preview + confirmed cost, daily/per-minute caps, crash-safe worker | implemented, OFF by default | PASS |
| Production CORS: credentialed only for `https://crm.nakulpathologylab.in`; website only on `/public/*`; localhost refused | backend `c921f60` | PASS |
| Twilio history | untouched; rows keep `provider: "twilio"`, MSG91 rows `provider: "msg91"`; unique index per `(provider, messageId)` | PASS |

---

## 2. Automated test results

| Check | Result | Status |
|---|---|---|
| Backend suite (`npm test`, in-memory DB, mocked MSG91 transport) — 2026-11-17, with the new test file | 458/458 pass, 0 fail (113 suites) | PASS |
| New `tests/msg91Completion.http.test.js` | 8/8 | PASS |
| Backend lint | no linter configured (`npm run lint` is a placeholder) | NOT TESTED |
| Frontend unit (`node --test`) — 2026-11-17 | 38/38 | PASS |
| Frontend UI (`vitest`) — 2026-11-17 | 185/185 (23 files) | PASS |
| TypeScript + production build (`npm run build` = `tsc -b && vite build`) — 2026-11-17 | 0 errors, build OK | PASS |
| Frontend lint (`oxlint`) — 2026-11-17 | 0 errors, 75 warnings (all pre-existing) | PASS |
| Local browser QA + API smoke (isolated in-memory backend) | 2026-11-16: 23/23 and 44/44 | PASS |

### 2a. Required MSG91 test cases → evidence (all mocked; fake numbers; no real send)

| Case | Test | Status |
|---|---|---|
| Successful outbound request | `msg91.http` "template: exact documented payload…", `msg91DashboardPayload.http` "payload equals the dashboard request…" | PASS |
| Invalid recipient | `msg91Completion.http` "invalid recipient numbers…" (+ not-allowlisted → 403 in `msg91.http`) | PASS |
| Missing template configuration | `msg91Completion.http` "template that MSG91 does not list…"; unapproved / disabled / unreadable list in `msg91.http`, `msg91DashboardPayload.http`, `msg91.unit` | PASS |
| Missing credentials | `msg91Completion.http` "missing credentials…"; `msg91.unit` "missing / invalid values are reported by name" | PASS |
| Provider timeout | `msg91.http` "timeout → 504 outcome unknown, row stays pending" | PASS |
| Provider rejection | `msg91.http` "'fail' envelope → 502…", `msg91DashboardPayload.http` "MSG91 rejection…" | PASS |
| Invalid provider response | `msg91Completion.http` "invalid provider response…" | PASS |
| Duplicate send on retry | `msg91Completion.http` "same idempotency key…", `msg91Conversation.http` "duplicate key is not resent" | PASS |
| Request ID storage | `msg91.http` / `msg91Completion.http` (`providerRequestId` stored, status `queued`) | PASS |
| Successful inbound + customer matching | `msg91.http` "inbound: stored once…, matched to the customer" | PASS |
| Unknown sender | `msg91Completion.http` "unknown sender is stored without a customer (no fake match)…" | PASS |
| Duplicate inbound webhook | `msg91.http` "inbound: stored once (duplicates ignored)" | PASS |
| Malformed webhook | `msg91Completion.http` "malformed JSON… → 4xx, nothing stored"; `msg91.http` "unknown/garbage events → 200 and nothing changes" | PASS |
| Delivered / read status | `msg91.http` "status: delivered → read…", "lifecycle queued → sent → delivered"; `msg91DashboardPayload.http` "submitted → sent → delivered → read" | PASS |
| Failed status | `msg91.http` "failed with Meta reason…"; `msg91DashboardPayload.http` "failed delivery report…" | PASS |
| Duplicate / out-of-order status event | `msg91.http` "duplicate and out-of-order (late 'sent'/'failed') ignored" | PASS |
| Unknown provider message ID | `msg91.http` "Unknown request id: never creates a row" | PASS |
| Twilio history preservation + provider filtering | `msg91Completion.http` "…leave the Twilio row unchanged" (status + inbound + `?provider=` filters); `msg91Conversation.http` "old Twilio history kept" | PASS |
| UI status labels (queued ≠ sent; delivered/read only from stored status) | frontend `whatsappMessageStatus.test.ts`, `WhatsappMessages.test.tsx`, `WhatsappConversation.test.tsx` | PASS |

---

## 3. Outbound MSG91 readiness audit (code + tests; nothing sent)

| Requirement | Implementation | Tests | Status |
|---|---|---|---|
| Approved template mapping | Template must be **APPROVED** in MSG91 right now and not disabled (fail closed; an approved result is cached ≤ 5 min); variables mapped to `body_n` / `header_1` / `button_n`; exact variable count enforced; namespace from MSG91 | `msg91.http.test.js` "templates…", "refusals…unapproved template", `msg91DashboardPayload.http.test.js` (7) | PASS |
| Recipient validation | Valid Indian mobile normalised to `91XXXXXXXXXX`; must be in `WHATSAPP_TEST_ALLOWLIST` (test-send always; others while `WHATSAPP_RESTRICT_TO_ALLOWLIST` ≠ false); opted-out (STOP) numbers refused for templates; config rejects a sender number that is also an allowlisted recipient | "refusals before any send: not allowlisted, wrong variables…" | PASS |
| Message record creation | Row created **before** the HTTP call (`pending`), saved after (`queued` on accept, `failed` on rejection); idempotency key + 60 s duplicate guard; timeout → outcome "unknown", never resent, never marked sent/failed | "exact documented payload… stored as queued with the request id (never 'sent')", "timeout → 504…", "'fail' envelope → 502…" | PASS |
| Provider request ID storage | `providerRequestId` = MSG91 `request_id`; wamid stored later in `messageId` from the status webhook | same + "status: …wamid stored" | PASS |
| Sent / delivered / read / failed handling | Forward-only state machine; timestamps per status; failed keeps Meta code + reason; "accepted" is never shown as sent/delivered | "status lifecycle queued → sent → delivered", "failed with Meta reason…", "refresh from logs…" | PASS |
| Outbound webhook mapping | `/msg91/status`: camelCase (Webhook New) and legacy snake_case fields; matched by request id or wamid (+ recipient); other integrated numbers and inbound-direction events ignored; races handled with 3 retries | "status lifecycle…; unknown/garbage events → 200 and nothing changes" | PASS |
| Duplicate event protection | Conditional update (`status ∈ allowed previous`), so duplicates and late events are no-ops; inbound upsert unique on `(provider, wamid)` | "duplicate and out-of-order (late 'sent'/'failed') ignored", "inbound: stored once" | PASS |
| Real outbound from **production** | — | — | NOT TESTED (requires §6 approval; one-off local-backend send on 2026-11-15 was delivered + read per MSG91 logs, but no status webhook was ever received) |

What is needed for one controlled production test: see FINAL_COMPLETION_CHECKLIST.md §5
(owner decision on the rotation gate, approved recipient + values, status webhook configured,
temporary `WHATSAPP_SENDING_ENABLED=true` with a one-number allowlist and campaigns off,
one test send, record queued → delivered evidence, switch sending off again).

---

## 3b. Local integration evidence (isolated local backend, not production)

| Event | Date | Evidence | Status |
|---|---|---|---|
| Real MSG91 template send from the local isolated backend (owner-approved, one allowlisted number) | 2026-11-15 | MSG91 accepted (request `69fdf657…`); MSG91 logs API: sent → delivered → read | PASS |
| Real MSG91 webhooks to the local tunnel | 2026-11-15 | none ever arrived (MSG91-side; later fixed for production inbound) | NOT TESTED |
| Synthetic webhooks through the tunnel (auth only) | 2026-11-14 | no / wrong secret 401, correct 200; nothing stored | PASS |

## 4. Real production event evidence

| Event | Date | Evidence source | Status |
|---|---|---|---|
| Real MSG91 **inbound** WhatsApp message | 2026-11-16 | Owner-observed: reached production, webhook secret accepted, stored once, matched the correct customer, shown in Conversations, Settings "Last MSG91 inbound" updated; no synthetic event; nothing sent | PASS |
| Webhook authentication (live) | 2026-11-17 (two rounds) | My read-only probe: `/msg91/inbound` and `/msg91/status` → 401 with no secret and with a wrong secret | PASS |
| Message history API protected (live) | 2026-11-17 | `/whatsapp/messages?provider=msg91` without login → 401 (provider filtering itself: automated tests §2a) | PASS |
| Admin-only MSG91 config endpoint | 2026-11-17 | `/msg91/config` without login → 401 | PASS |
| API health / database | 2026-11-17 | `/health` 200, `database connected`, commit `e982d83` | PASS |
| CORS | 2026-11-17 | CRM origin 204; `http://localhost:3000` 403 | PASS |
| Real **outbound** send from production | — | none | NOT TESTED |
| Real **delivery status** webhook event | — | none ever received (production or tunnel) | NOT TESTED |
| Real campaign | — | campaigns off by policy | NOT TESTED |
| MSG91 account templates (read-only `npm run msg91:check`, local key file; nothing sent) | 2026-11-17 | auth OK; sender …4729 matches; only template `testing` (en, UTILITY, APPROVED, 4 vars); **no MARKETING template** | PASS (test template) / BLOCKED (campaigns: no Marketing template) |
| Logged-in production modules | 2026-11-15 | last owner-guided pass, all OK; not repeated | NOT TESTED this round |

---

## 5. WhatsApp safety switches and security (owner dashboard state)

I have no production admin login or Render access, so these cannot be read independently.
None was changed.

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | `WHATSAPP_PROVIDER` = MSG91 | NOT TESTED (owner: MSG91, 2026-11-16) | the real inbound landing via the MSG91 handler is consistent with it but does not prove it (the webhook works for any provider) |
| 2 | `WHATSAPP_SENDING_ENABLED=false` | NOT TESTED (owner: OFF, 2026-11-15) | not re-confirmed after the 2026-11-16 Render changes |
| 3 | `WHATSAPP_CAMPAIGNS_ENABLED=false` | NOT TESTED (owner: OFF, 2026-11-15) | same |
| 4 | Campaign worker OFF | NOT TESTED | starts only when 3 is true; Render log line `Campaign worker not started…` proves it |
| 5 | `JWT_SECRET` rotated | BLOCKED (owner) | not confirmed; leaked secret was still accepted on 2026-11-15 |
| 6 | `COOKIE_SECRET` rotated | BLOCKED (owner) | not confirmed |
| 7 | MongoDB Atlas credentials rotated | BLOCKED (owner) | not confirmed |
| 8 | Cloudinary credentials rotated | BLOCKED (owner) | not confirmed |
| 9 | Admin password changed, unknown users reviewed | BLOCKED (owner) | not confirmed |
| 10 | `SEED_ADMIN_*` removed from Render | BLOCKED (owner) | not confirmed |
| 11 | Git history exposure (backend `46e8274`) | FAIL | still present (private repo); rotation neutralises it; rewrite needs approval |
| 12 | Production CORS restricted | PASS | §4 |
| 13 | Atlas backup verified | BLOCKED (owner) | owner said done; no snapshot time given |
| 14 | Restore tested on a separate target | BLOCKED (owner) | owner said done; no target or counts given |

Leaked historical credentials were never read, used or printed in this closure.

**Activation gate: CLOSED** (items 5–10 open).

---

## 6. Remaining owner actions

Exact Render variable names, webhook URLs and header: `MSG91_FINAL_SETUP_GUIDE.md`.

**Dashboard actions (owner only):**
1. Settings → WhatsApp (or Render → Environment): confirm provider MSG91, sending OFF,
   campaigns OFF; confirm the Render log shows `Campaign worker not started`.
2. Render: new `JWT_SECRET`, different new `COOKIE_SECRET`, delete `SEED_ADMIN_*`.
3. Atlas: new DB user/password → update `MONGODB_URI` on Render → delete the old user.
4. Cloudinary: new API key/secret → update Render → disable the old key.
5. CRM: change the admin password; review the user list.
6. Atlas: share the latest snapshot time and the separate restore target + document counts
   (no credentials).
7. MSG91: confirm the status webhook (*On Outbound Report Received*) URL, header and not paused.

**Approval-required (not done; each needs an explicit yes):**
- The one controlled production outbound test (FINAL_COMPLETION_CHECKLIST.md §5).
- Enabling production sending or campaigns after that test.
- Rewriting backend Git history.
- Any further push, deploy or production configuration change.
