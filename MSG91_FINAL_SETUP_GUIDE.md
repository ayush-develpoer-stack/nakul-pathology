# MSG91 WhatsApp — Final Setup Guide

Date: 2026-11-17. Applies to backend `e982d83` (production) and later.
This guide lists variable **names** only. Never paste secret values into chat, tickets,
commits or this file. Nothing in this guide has been applied by me; every step is an owner
action.

---

## 1. Render → backend service → Environment

Every name below is read by `backend/src/config/env.js`. No other MSG91 variables exist.

### Required for MSG91

| Variable | Purpose | Value format / rule |
|---|---|---|
| `WHATSAPP_PROVIDER` | Selects the active WhatsApp provider | exactly `msg91` (default when unset is `meta`; there is no Twilio fallback) |
| `MSG91_AUTH_KEY` | MSG91 API auth key (sent as the `authkey` header; never logged or sent to the browser) | from MSG91 → Settings / API keys. **Secret** |
| `MSG91_WHATSAPP_NUMBER` | The integrated **sender** number in MSG91 → WhatsApp → Numbers | digits with country code, `91XXXXXXXXXX`. Must not be a test recipient. Inbound/status events for any other integrated number are ignored |
| `MSG91_WEBHOOK_SECRET` | Shared secret MSG91 must send in the `X-Webhook-Secret` header | long random value (e.g. 48 random bytes, base64url). **Secret**. Unset → webhooks return 503 |
| `WHATSAPP_TEST_ALLOWLIST` | Comma-separated recipients allowed while the allowlist restriction is on | 10-digit Indian mobiles (or with `+91`). Test-send is **always** limited to this list |

### Safety switches

| Variable | Purpose | Required value now |
|---|---|---|
| `WHATSAPP_SENDING_ENABLED` | Master switch for any outbound WhatsApp (test-send, replies, campaigns). Only the exact string `true` enables it | `false` (or unset) |
| `WHATSAPP_CAMPAIGNS_ENABLED` | Starts the campaign worker. Only `true` enables it | `false` (or unset) |
| `WHATSAPP_RESTRICT_TO_ALLOWLIST` | While not exactly `false`, replies and campaign sends are also limited to `WHATSAPP_TEST_ALLOWLIST` | unset or `true` |

### Campaign-only (leave unset while campaigns are off)

| Variable | Purpose | Default |
|---|---|---|
| `WHATSAPP_CAMPAIGN_MAX_PER_MINUTE` | Campaign throughput cap | 20 (1–600) |
| `WHATSAPP_CAMPAIGN_MAX_RECIPIENTS` | Max recipients per campaign | 1000 (1–20000) |
| `WHATSAPP_CAMPAIGN_DAILY_LIMIT` | Rolling 24 h cap across all campaigns (set to your WhatsApp messaging tier) | 250 |
| `WHATSAPP_CAMPAIGN_COST_PER_MESSAGE_INR` | Price per template message for the pre-start cost estimate | unset → MSG91 campaigns cannot start |

Not used by MSG91: `TWILIO_*` and `META_WHATSAPP_*` (only read when that provider is
active). Keep existing Twilio values or remove them; existing Twilio message history is stored
in the database and is not affected either way.

After saving, wait for the Render deploy, then check `GET /api/v1/health` →
`database: connected`, and CRM → Settings → MSG91: provider MSG91, configured, sending
OFF, campaigns OFF.

---

## 2. MSG91 dashboard → WhatsApp → Webhook (New)

Create **two** webhooks for the integrated number above.

| Event | URL | Method | Content type | Header |
|---|---|---|---|---|
| On Inbound Request Received | `https://api.nakulpathologylab.in/api/v1/whatsapp/msg91/inbound` | POST | `application/json` | `X-Webhook-Secret: <same value as MSG91_WEBHOOK_SECRET on Render>` |
| On Outbound Report Received | `https://api.nakulpathologylab.in/api/v1/whatsapp/msg91/status` | POST | `application/json` | `X-Webhook-Secret: <same value>` |

Responses from the CRM:
- 200 — accepted (also for events it ignores: other numbers, unknown request ids,
  duplicates, unknown event names — so MSG91 does not pause the webhook).
- 401 — header missing or wrong. Fix the header; MSG91 may pause a webhook after repeated 4xx.
- 503 — `MSG91_WEBHOOK_SECRET` is not set on Render.

Check both webhooks show **active** (not paused). If one is paused, fix the cause, then
re-enable it in the dashboard.

Verification without sending anything (anyone can run it; uses a wrong secret on purpose):

```
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Content-Type: application/json" -H "X-Webhook-Secret: wrong" -d "{}" https://api.nakulpathologylab.in/api/v1/whatsapp/msg91/inbound
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Content-Type: application/json" -H "X-Webhook-Secret: wrong" -d "{}" https://api.nakulpathologylab.in/api/v1/whatsapp/msg91/status
```

Both must print `401` (verified 2026-11-17).

---

## 3. Templates

The CRM never invents template names or variables: it reads them live from MSG91 for the
integrated number and sends only templates MSG91 reports as **APPROVED** and not disabled,
with exactly the variables the template defines (`body_1…`, `header_1`, `button_1`).

Live read-only check, 2026-11-17 (`npm run msg91:check` with the local
`.env.msg91.local`; nothing sent): auth key accepted; sender `XXXXXXXX4729` matches the
integrated number; MSG91 returns exactly **one** template for it:

| Template | Language | Category | Status | Variables |
|---|---|---|---|---|
| `testing` | en | UTILITY | APPROVED, sendable | `body_1`, `body_2`, `body_3`, `body_4` |

**No MARKETING template exists**, so no campaign can start (campaigns accept approved
MARKETING templates only). Create one in MSG91 → WhatsApp → Templates and wait for Meta
approval first (§6).

---

## 4. One controlled production test (approval required — nothing sent yet)

Before step 1, I need your explicit approval of: the recipient (must be the single
allowlisted number, currently ending 5157 locally), template `testing` (en), and the exact
values for `body_1`–`body_4`. One send only; no automatic retry.

1. **Render (you):** `WHATSAPP_TEST_ALLOWLIST` = that one number only;
   `WHATSAPP_RESTRICT_TO_ALLOWLIST` unset or `true`; `WHATSAPP_CAMPAIGNS_ENABLED=false`;
   `WHATSAPP_SENDING_ENABLED=true`. Save once, wait for the deploy, `/health` = connected.
2. **CRM → Settings → MSG91 (you, admin):** provider MSG91, configured, no missing variables,
   template `testing` listed as sendable.
3. **Send once:** MSG91 test send → recipient, template `testing` (en), the 4 approved values.
   Click Send **once**. If the result is "outcome unknown" (timeout), do **not** resend: use
   **Check MSG91 logs** in the same panel.
4. **Evidence (record each):**
   1. Messages page: a new row, provider **MSG91**, outbound, status **Queued**, MSG91
      request id present (never "Sent" at this point).
   2. Within minutes the **same row** moves to Sent → Delivered (→ Read once opened), with
      the timestamps — this comes only from the real *On Outbound Report Received* webhook.
   3. Failure instead: status **Failed** with MSG91's reason/code.
   4. Render logs: `MSG91 status: "delivered" for request <id> → updated` (no secrets or
      full numbers are logged).
   5. Settings → MSG91: **Refresh status** shows the new status; "Last MSG91 delivery" shows
      a timestamp.
5. **Immediately after (you):** `WHATSAPP_SENDING_ENABLED=false` on Render → deploy →
   Settings shows sending OFF, campaigns OFF.

If the row stays Queued for ~10 minutes: check MSG91 → Webhook (New) → the status webhook
is active / not paused and its logs. **Check MSG91 logs** shows MSG91's view but does **not**
prove the webhook works. Do not send a second message without a new approval.

---

## 5. Environment readiness (names only)

"Prod state" is what can be known without login or reading values.

| Variable | Read by code | Outbound send | Inbound webhook | Status webhook | Prod state (2026-11-17) |
|---|---|---|---|---|---|
| `WHATSAPP_PROVIDER` (=`msg91`) | yes (`env.js`) | **required** | not checked | not checked | owner: MSG91 (16 Nov); not independently readable |
| `MSG91_AUTH_KEY` | yes | **required** | — | — | not readable anonymously |
| `MSG91_WHATSAPP_NUMBER` | yes | **required** (sender) | **required** when the event names an integrated number (other numbers ignored) | same | very likely set and correct: the real inbound event was stored, which requires a match |
| `MSG91_WEBHOOK_SECRET` | yes | warning only | **required** (unset → 503) | **required** | **set**: both webhooks return 401, not 503 |
| `WHATSAPP_TEST_ALLOWLIST` | yes | **required** (config incomplete without it; test-send always limited to it) | — | — | not readable anonymously |
| `WHATSAPP_SENDING_ENABLED` | yes | **required = true** to send | — | — | owner: OFF (15 Nov); keep OFF |
| `WHATSAPP_CAMPAIGNS_ENABLED` | yes | campaigns only | — | — | owner: OFF (15 Nov); keep OFF |
| `WHATSAPP_RESTRICT_TO_ALLOWLIST` | yes | limits replies/campaigns when not `false` | — | — | unset = restricted (safe default) |

The admin-only `GET /api/v1/whatsapp/msg91/config` (CRM → Settings → MSG91) shows the
missing/invalid variable **names** without values — that is how to confirm the unreadable
cells above.

---

## 6. Marketing campaign activation checklist (not activated)

Code-level safeguards exist and are covered by automated tests; none has been used with a
real campaign. Every box needs your action or approval.

1. [ ] **Marketing template:** create in MSG91, category MARKETING, wait for APPROVED. The
       CRM refuses Utility / Authentication / unknown-category templates for campaigns.
2. [ ] **Consent:** only customers with WhatsApp opt-in are included; opted-out (STOP) numbers
       are excluded at selection *and* re-checked at send time; START re-subscribes. Confirm
       your customer opt-in data is accurate before the first campaign.
3. [ ] **Duplicate prevention:** recipients de-duplicated per campaign; atomic claims mean a
       recipient cannot be sent twice even after a crash/restart; timeouts are never resent.
4. [ ] **Limits:** set `WHATSAPP_CAMPAIGN_DAILY_LIMIT` to your WhatsApp messaging tier (default
       250/24 h) and review `WHATSAPP_CAMPAIGN_MAX_PER_MINUTE` (default 20) and
       `WHATSAPP_CAMPAIGN_MAX_RECIPIENTS` (default 1000).
5. [ ] **Cost:** set `WHATSAPP_CAMPAIGN_COST_PER_MESSAGE_INR` from your MSG91 pricing (without
       it MSG91 campaigns cannot start); the start dialog requires confirming the exact count
       and cost.
6. [ ] **Worker safety:** the worker runs only with `WHATSAPP_CAMPAIGNS_ENABLED=true` and sends
       only with `WHATSAPP_SENDING_ENABLED=true`; pause/cancel stop further sends.
7. [ ] **Prerequisites:** credential rotation done; the one-message test (§4) passed with a
       real delivery webhook.
8. [ ] **Pilot:** keep `WHATSAPP_RESTRICT_TO_ALLOWLIST` on, put 2–5 consenting staff numbers in
       `WHATSAPP_TEST_ALLOWLIST`, run one small campaign, verify per-recipient
       delivered/read/failed and the report counters, then switch campaigns OFF and review
       before any real audience.
