# Safety review of the phase 4 surfaces (origin/main 4733a1e)

Independent read-only review commissioned by the orchestrating session, 2026-10-11, after
phase 4 (docs/PHASE4_BRIEF.md). Every row must be fixed, with a regression test that fails
before and passes after, before the first Mac build. Status is updated by the fix session.
Nothing here may weaken a fix from docs/SECURITY_REVIEW_2026-10-10.md.

| ID | Sev | Finding | Fix | Status |
| --- | --- | --- | --- | --- |
| H1 | HIGH | Pairing trusts the chat, not the user (`sidecar/channels/registry.js` isPaired/inbound/decide/ask; `telegram.js` never checks `chat.type === 'private'`; `slack.js` accepts message/block_actions from any channel member). Any member of a paired group can approve a money_out card and the record attributes it to the owner. | Require `message.userId === chats[key].userId` on gate/notes/command/ask paths; refuse pairing from non-private chats (Telegram chat.type !== 'private', Slack channel type !== 'im'; Discord DM-only enforced); emit the real sender in every event. Test: a second user in a paired chat is refused and logged. | fixed eaeb89a |
| H2 | HIGH | Computer control can drive Maka's own window (`sidecar/computer/policy.js` SENSITIVE_APPS and `src-tauri/src/computer_policy.rs` have no entry for com.makapark.maka / "Maka", nor a browser-on-loopback rule). At Act with cap a Ranger can focus Maka, locate "Approve" and click its own Gate items. | Add Maka's bundle id and name to both lists; in the shell refuse when the frontmost window title/URL names the sidecar host:port; treat browsers as sensitive on purchase and computer runs. Test with the fake shell reporting com.makapark.maka frontmost. | fixed addf938 |
| H3 | HIGH | One-click / saved-payment checkouts bypass the payment handoff (`sidecar/browser/detect.js` needs card-field phrases or "pay now / place order"; `cdp.js` looks for cc inputs or payment iframes). "Buy now", "Confirm order", "Submit order", "Buy with Shop Pay / Apple Pay" on a logged-in supplier with a saved card places the order with no human step. | On purchase runs refuse any click whose target text matches /buy now\|confirm\|submit\|complete\|place order\|pay\|checkout/i and any submit on URLs matching /checkout\|cart\|order\|pay\|purchase/; broaden the payment regex (buy now, confirm order, submit order, complete order, payment method, ending in, saved card); hand off on a checkout URL pattern alone. | fixed b3ba0a7 |
| M1 | MED | MCP `readOnlyHint` is server-asserted and lands tools in `research` (act_free, unjudged); `@latest` servers re-list tools on every connect without re-approval (`sidecar/mcp/manager.js` domainFor/register/connect). A server update shipping `send_money` annotated readOnlyHint:true runs free. | Snapshot the sanitized tool list (name + annotations + description hash) in the Gate item at add; new or changed tools default to outbound_messages/Draft until accepted (`mcp.server {status:'tools_changed'}` + Gate item); treat readOnlyHint as research only when destructiveHint !== true. | fixed ae9625b |
| M2 | MED | Purchase hold settles at the Ranger-reported total (`sidecar/purchases.js` receipt: settleHold with input totalUsd; evidence = newest trace read/screenshot of any page). Declared $900, paid $900, reported $1 → cap room reopens. | Settle at max(declared, reported) unless the Superintendent's hand-back notes state the paid amount (ask for it on payment handoffs at /api/browser/handoff/:id/return); require the evidence URL to be the handoff's host. | open |
| M3 | MED | Recipe steps fall back to any Ranger of the specialty (`sidecar/recipes/index.js` receiverFor → rangers[0]) and results attribute by the Ranger's venture. A recipe for venture B run by A's Ranger scores A with B's results and a kill of B never pauses the listing. | With a ventureId refuse NO_RANGER unless a Ranger of that venture has the specialty (or hire into B as the Chief does); carry `venture` on the work item and attribute by item. | open |
| M4 | MED | Imported persona/instructions enter the system prompt; preview truncated to 600 chars; `sidecar/import/homes.js` readText follows symlinks and the workspace path may point anywhere. An AGENTS.md with hidden instructions, or a SOUL.md symlinked to a private key, lands in layout.json. | lstat and refuse symlinks; keep the workspace inside the home dir; show the full persona in preview; import instructions as a skill the owner enables, never as persona. | open |
| L1 | LOW | `netguard.js` guardedFetch re-sends the full init (Authorization, mcp-session-id) to every redirect hop; a cross-host redirect leaks the bearer. | Drop authorization and session headers when the host changes. | open |
| L2 | LOW | `mcp/manager.js` validateServerSpec refuses only authorization/cookie headers; x-api-key etc. stored plaintext in mcp-servers.json (contradicts D134). | Require `$SECRET:` for all header values. | open |
| L3 | LOW | Stdio `env` values are not on the Gate card (names only); PATH/NODE_OPTIONS/DYLD_* can redirect npx to another binary. | Show the values, or refuse those names. | open |
| L4 | LOW | Hosted cap check and the cost.estimate count are not atomic (`creative/images.js`, `voice.js`): N concurrent calls at cap−1 all pass. | A reserve-style hosted reservation in the ledger. | open |
| L5 | LOW | `results.js` kill rule reads `(w.orders \|\| 0) === 0`: null orders read as zero. | Require `w.orders !== null`. | open |
| L6 | LOW | Every Peak question calls `reflect.gather()`, which rolls the day up as a side effect. | Read-only gather for questions. | open |

Verified correct by the same review (keep it that way): pairing code entropy, TTL, single use
and lockout; replayed updates dropped; "ask the Peak" runs with no grants; tokens never in
routes or events; gateway URLs netguard-checked; MCP tool-name prefixing, description
sanitising, call-time domain resolution, money mapping refused without a reading, OAuth
tokens only in the keystore, stdio children with named env only; creative generation refused
without an approving judge and the hosted cap checked first; results start null and become 0
only when a source synced; kills are Chief-delegated work items through the Gate; memory
redaction before dedupe/judge/write with scope enforced on recall; recipes cannot grant tools
or leashes; listing create, activation and price are separate Gate items in the right
domains; voice transcripts need explicit clicks; purchase holds placed before delegation and
executors never the requester; computer tools all under computer_control with Observe refusing
before the shell is asked; every new non-GET route passes the token/Origin/JSON check; imports
honour the never-read list.
