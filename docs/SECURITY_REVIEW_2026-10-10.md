# Safety review of the money and permission path (origin/main 773081c)

Independent read-only review commissioned by the orchestrating session, 2026-10-10.
Every item below must be fixed, with a regression test that fails before and passes after,
before the first Mac build. Status column is updated by the fix session.

| ID | Sev | Finding | Fix | Status |
| --- | --- | --- | --- | --- |
| H1 | HIGH | A Ranger can drive Maka's own UI with its browser or `web.fetch`/`web.read` (no loopback/private-host block: `sidecar/browser/tools.js` browser.open/download, `sidecar/capability/tools.js` web.fetch, `sidecar/research/read.js` web.read) and approve its own Gate items or edit leashes via the unauthenticated 127.0.0.1 routes. | Reject loopback, link-local, RFC1918, `.local`/`localhost` and the sidecar's own host:port after DNS resolution in all four tools; plus M4. | fixed 1dba4f9 |
| H2 | HIGH | Ad activation counted as $0 when a campaign has no campaign-level `dailyBudget` (`meta-ads.js` `budgetOf`, `google-ads.js`): at act_capped with cap 0 the activation passes the cap check and spends the real budget. | Unknown or zero amount for a money_out action = cannot prove the amount → always a Gate item; count lifetime budgets; refuse activation of campaigns with no campaign-level budget in the store. | fixed 8af96ae |
| M1 | MED | Daily cap check-then-record race across concurrent runs (`gate.js` checks sync, records after the HTTP call). Four Rangers × $40 under a $50 cap all pass. | Reserve in the ledger before `run()` (reserve → execute → commit/release), serialised. | fixed 6857a28 |
| M2 | MED | Caps keyed by domain only (agent cap compared to park-wide spend); caps enforced only at act_capped so an approved proposal to act_free removes money_out's cap silently; a zone/agent `{level:'act_capped'}` without `dailyCapUsd` drops the park cap. | Refuse proposals to act_free in money_out/money_in (or keep caps enforced at act_free for money domains); inherit `dailyCapUsd` from the park layer when the winning layer omits it; key ledger rows by agent+domain when the cap is agent-scoped. | fixed 2c463a5 |
| M3 | MED | `/api/run` accepts `review:false` from the HTTP body, skipping the judge for any Ranger. | Whitelist `/api/run` body fields; `review:false` becomes an internal option only (Chief path). | open |
| M4 | MED | Localhost CSRF: mutating routes accept cross-origin simple requests, no Origin/Host check, JSON parsed regardless of Content-Type. | Require `Content-Type: application/json` and a matching `Origin`/`Host`, plus a per-boot token the frontend fetches once from `/api/state` and sends on every mutating request; reject otherwise. | open |
| M5 | MED | Mail kind is self-declared: domain, hourly ceilings and the unsubscribe footer depend on `input.kind`; `to` is unbounded. A "notification" to 5,000 addresses goes under outbound_messages with no footer. | Derive kind in one policy function from recipients and thread headers (campaign whenever `to` > 1 or not a reply to a known thread); the tool's `domain()` uses that same function with the draft loaded; bound `to`. | open |
| M6 | MED | "New external recipient" judge trigger defeated by drafting first (`isNewExternal` scans drafts stored as `direction:'out'`). | Exclude `status:'draft'` from `isNewExternal` and from `sentLastHour`. | open |
| L1 | LOW | Browser handoff detection runs after the action and suppresses repeats for the same kind+URL once returned; a returned checkout page lets the next "Place order" click run unchecked. | Detect before and after each action; on a payment page require the handoff be `returned` with explicit notes to continue. | open |
| L2 | LOW | Stripe amounts treated as USD regardless of charge currency. | Convert or restrict to USD charges; refuse otherwise. | open |
| L3 | LOW | A throwing `tool.domain()` yields no domain → tool runs under the no-domain path. | Fall back to `TOOL_DOMAINS[name]` or refuse. | open |
| L4 | LOW | Delegation `budgetUsd` for sub-runs unchecked against the delegator's budget. | Cap at the delegator's remaining budget. | open |
| L5 | LOW | The Chief is unjudged by design (D51); a connector fixture at the Peak would let it act in money domains without a judge. | Refuse connector fixtures at the Peak, or judge the Chief's money-domain actions. | open |

Also: `npm run test:fast` showed one non-reproducing failure in three runs (213/214 once). Find and
fix the flaky test.

Verified correct by the same review (keep it that way): leash resolution order; park default
money_out = draft with cap 0; every connector write declares the right domain and reaches HTTP
only via `gate.execute`; no server route performs a connector write; earned loosening never
auto-applies; no agent tool mutates leashes or caps; judge caps and escalation to Draft; mail
`allowedFrom`, suppression, Resend webhook HMAC with timing-safe compare; browser tools all
under browser_control; keystore 0600, no key logging, status endpoints return booleans only.
