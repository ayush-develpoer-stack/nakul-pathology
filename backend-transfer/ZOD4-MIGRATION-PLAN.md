# Zod 3 → 4 migration plan (separate task — not done in this sprint)

## Remaining advisory
- `zod <4.6.6` — HIGH — GHSA-mrhx-c7xc-m3w5: memory exhaustion while validating
  oversized *constrained collections*. Production dependency. Only fix is zod 4 (major).

## Current exposure (why it was deferred, not ignored)
- Every request body is capped at **2 MB** (`express.json` / `urlencoded` limit in `src/app.js`),
  so an attacker cannot send an arbitrarily large array to a validator.
- Public endpoints have their own rate limit (`PUBLIC_RATE_LIMIT_MAX_REQUESTS`, default 60 / 15 min).
- Risk is therefore reduced, not removed. Treat as a must-fix before scaling up public traffic.

## Plan (est. 0.5–1 day incl. tests)
1. Branch; `npm i zod@^4.6.7` (no `--force`, nothing else upgraded).
2. Zod is used in 14 files under `src/` (validators + `middleware/validate`). Review for v4 breaking changes:
   - error shape: `err.errors` → `err.issues`; `.flatten()` / `.format()` deprecated → `z.treeifyError` / `z.flattenError`.
     The `validate` middleware's field-error mapping is the main touch point.
   - `message:` params → `error:`; `invalid_type_error` / `required_error` removed.
   - `z.string().email()` / `.url()` → `z.email()` / `z.url()` (old forms still work, deprecated).
   - `.default()` now short-circuits on `undefined` and must match the OUTPUT type; check every `.default(...)`
     in validators (several optional strings default to "").
   - `z.record()` requires both key and value schemas.
   - `.strict()` / `.passthrough()` → `z.strictObject` / `z.looseObject` (old still work).
3. Run `npm test` + `npm run test:db` — every validator path (400 responses with field names) is covered by
   the DB suites (core, phase2, customer import). All must stay green with identical status codes and field names.
4. Frontend: no change needed (frontend does not depend on zod) — but re-run the UI suite, which asserts
   field-error rendering from the API's error shape.
5. `npm audit --omit=dev` → expect 0.
