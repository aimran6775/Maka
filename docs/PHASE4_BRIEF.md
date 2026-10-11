# Maka — Phase 4 brief: beyond StarNet

Owner decision 2026-10-11: build all of it, full autonomy. Read README.md, CODE_MAP.md,
docs/BRAIN.md, CLAUDE.md, docs/KICKOFF_BRIEF.md, docs/DECISIONS.md, docs/PHASE2_BRIEF.md,
docs/SECURITY_REVIEW_2026-10-10.md (the safety bar: nothing here may weaken a fix) first.
Same working rules as every phase: Node core only in the sidecar (Rust/Swift allowed only in
src-tauri/), vanilla ES modules + vendored Three.js in the frontend, additive-only shared
contract, truthful telemetry, atomic persistence, regression tests for every behaviour,
test:fast green before every push, one commit per step pushed to main, docs true to the build.
No real keys here: fakes for every external service. Ambiguity: the stricter option, recorded
in docs/DECISIONS.md, no stopping to ask.

Two sessions build this: Session A does Parts A–C, Session B does Parts D–E. Each sends the
parent a summary when done. A safety review follows Session B.

## Part A: channels (the Peak on your phone)
1. Channel adapter contract. `sidecar/channels/adapter.js`: an adapter exposes
   `start/stop`, `sendCard(chatId, card)`, `sendText`, and emits `channel.inbound`
   (channel, chatId, userId, text, action). `sidecar/channels/registry.js` holds adapters;
   `channel.connect` (up/down/error) and `channel.delivery` events (additive). Owner
   pairing: a one-time 8-character code shown at the Peak must be sent from the owner's
   chat before that chat is trusted; only paired chats may act on Gate items; pairing state
   persisted atomically; unpair from the Peak. Bot tokens live in the keystore/broker.
2. Telegram. `sidecar/channels/telegram.js`: Bot API over long polling with core `fetch`;
   Gate items delivered as cards with inline buttons Approve / Revise / Reject (Revise asks
   for notes as the next message); reflections, away digests and `channel.delivery`
   outcomes delivered; "ask the Peak" (free text from a paired chat → a Chief run whose
   answer returns with evidence links). Secrets: TELEGRAM_BOT_TOKEN. Fake Bot API in tests,
   including a replayed update id and an unpaired chat trying to approve (refused, logged).
3. Discord and Slack. Same adapter contract; Discord via the Interactions/Gateway REST
   paths that core WebSocket can serve, Slack via Socket Mode or Events API; inline buttons
   for the Gate card in both. Secrets: DISCORD_BOT_TOKEN, SLACK_BOT_TOKEN/SLACK_APP_TOKEN.
   Fakes in tests. Peak card lists channels with pairing state; park: a Radio Tower fixture
   at the Peak shows which channels are up.

## Part B: MCP (reach any service)
4. MCP client. `sidecar/mcp/client.js`: Model Context Protocol over stdio (spawned
   process) and streamable HTTP, JSON-RPC, `initialize`, `tools/list`, `tools/call`,
   `resources/list/read`, with OAuth 2.1 + PKCE through the Gate like connectors.
   `sidecar/mcp/manager.js`: servers configured at the Peak (command or URL), each server
   grants its tools through a new fixture kind `outpost` placed in a zone; every MCP tool
   is mapped to a leash domain (default: `research` for read-only annotated tools,
   `outbound_messages` otherwise, overridable per tool at the Peak, money domains require
   an explicit amount function or the tool is treated as unknown-amount → Gate). The
   netguard applies to HTTP servers. Fake MCP servers (stdio and HTTP) in tests. The
   `tools/list` schemas are sanitised before reaching the model (no prompt injection via
   descriptions longer than N chars; descriptions shown to the Superintendent at placement).
5. Curated catalog. `sidecar/mcp/catalog.json`: a small vetted list (filesystem, GitHub,
   Google Drive, Notion, Slack, Postgres, Brave Search) with one-click config and the leash
   mapping proposed; the Superintendent approves placement at the Gate.

## Part C: closing the connector gaps
6. Reflection briefings into station mail: each briefing is sent to the department's
   station address from peak@ via the mail system (kind `briefing`, internal recipients
   only, no footer, not a campaign); station mail views show them; notes files remain as
   the on-disk copy.
7. Ad sets, ad groups, ads and creatives. Meta: ad sets (targeting, budget at set level
   counted for money_out), ads, ad creatives (image + copy upload). Google: ad groups,
   responsive search ads (headlines/descriptions), image assets. All creates paused;
   activation and budget = money_out with the real amount; copy = publishing. Fake servers.
8. Ad creative generation. `sidecar/creative/`: copy variants by the worker with judge
   review; images via Hugging Face Inference image models (HF_TOKEN; metered under the
   hosted_worker cap) with an explicit no-faces / no-brand-logos policy check by the judge;
   outputs are deliverables in the venture's outbox, reviewed at the Gate under publishing
   before any upload. Fake HF endpoint in tests.

## Part D: outcomes, memory, playbooks
9. Results engine. `sidecar/results.js`: per venture and per Ranger from real ledgers and
   connector syncs only: revenue, refunds, fees, ad spend, model spend (worker/judge/hosted),
   mail volume, orders; unit economics (contribution per order, model cost per order,
   payback); daily rollups persisted; `results.rollup` event. Chief rules in the reflection:
   scale / hold / kill proposals with the numbers that drove them; kill = pause campaigns
   and listings (publishing/money_out via the Gate as usual). Peak portfolio card shows
   the table and sparklines drawn in canvas/SVG by hand (no chart library). Nothing
   projected; absent data shows "no data", never zero.
10. Scout memory. `sidecar/scout-memory.js`: every venture brief is stored with its
    go/no-go, and later joined to the results engine's actuals for that venture; a scored
    history (precision of the Scout's estimates, by niche and channel) is injected into the
    Scout's prompt and into the judge's review of new briefs; "what we learned" shown at the
    Research camp card.
11. Ranger memory. `sidecar/memory/`: per-agent memory store (facts, preferences,
    procedures, with scope agent / venture / station), a `memory.recall` tool and automatic
    recall of the top-k relevant items (lexical scoring, no embeddings dependency) into the
    run context, `memory.write` proposed by the Ranger and accepted by the judge, feedback
    👍/👎 from the Superintendent on the Ranger card, redaction of secrets and personal data
    before storage, events `memory.recall/write/forget/feedback` (additive).
12. Recipes and skills. `sidecar/recipes/`: a playbook is a versioned document (goal,
    steps as task briefs, required fixtures, leash needs, success check) stored in
    `_peak/recipes/`; granted to a role or a Ranger; run as a sequence of work items along
    trails; a starter library in `recipes/starter/` (launch an Etsy listing, weekly ad
    review, support inbox sweep, supplier reorder check, monthly books close). Skills are
    reusable instruction packs attached to a Ranger's persona; both visible on cards.
13. Listing pipeline. The Listings Ranger end to end: product data (from the Scout or the
    Superintendent) → copy → images (creative module) → price proposal (money_in) → draft
    listing on Shopify/Etsy (publishing, created unpublished) → judge review → Gate →
    publish. One recipe in the starter library drives it. Demo'd in the phase 4 demo.

## Part E: the senses and the edges
14. Voice. Push-to-talk in the park: speech-to-text through the Tauri shell using macOS
    Speech (Swift, on-device) with the browser's MediaRecorder + Hugging Face ASR as the
    fallback when not in the shell; one station voice out via macOS AVSpeechSynthesizer in
    the shell, Web Speech API fallback. The sidecar only sees text. Transcripts are shown
    before they are sent as a mission or a Peak question (nothing acts on a misheard word).
15. Renderer: distance level-of-detail for foliage and crew, instancing kept, the WebGPU
    renderer path when `navigator.gpu` exists with WebGL2 fallback, frame-time overlay in
    dev, a `park:bench` script that reports median frame time on a dense park.
16. Ledger Desk fixture (grants `ledger.read` for Books) and a keyless trends alternative
    recorded (Wikipedia pageviews + HN exist; add Reddit's public JSON listings under its
    rules and Etsy's own trending endpoints where the API offers them). Google Trends
    stays excluded (D86).
17. Supplier purchasing through the browser: a `purchase.request` work item (venture,
    supplier URL, items, amount) that is money_out with the amount declared and reserved,
    executed by the Ranger's browser up to the payment page, which ALWAYS hands off to the
    Superintendent (payment pages never auto-submit); receipt captured to the outbox and
    the ledger reconciled against the connector's charge when it appears.
18. Computer control, macOS only, strictest defaults. New leash domain `computer_control`
    (additive to the enum), park default Observe. Implemented in the Tauri shell (Swift /
    Rust via Accessibility and CGEvent APIs: screenshot, locate by accessibility tree,
    click, type, key chords, app focus), exposed to the sidecar over the existing local
    broker socket, never as raw HTTP. Every action is traced with before/after
    screenshots; a visible on-screen banner while a Ranger drives; a global hotkey that
    halts it; sensitive apps (banking, password managers, System Settings, Terminal)
    always hand off; judge review on every action at Act with cap; no autonomous use at
    all until the Superintendent raises the leash at the Gate. Linux tests cover the
    protocol and the policy with a fake shell; the Mac side is verified in the runbook.
19. Import from OpenClaw and Hermes homes: persona, instructions, memory and model mapped
    to a Ranger; keys never transferred. Low priority; do last.
20. Done means: `scripts/demo-phase4.mjs` (mission → Scout brief scored against memory →
    listing pipeline to a draft listing → ad set + creative to the Gate → Telegram card
    approve through the fake Bot API → results rollup → reflection briefing lands in
    station mail), test:fast, park:check, release:dry green; docs/LIVE_TEST.md extended
    with the channel, MCP and voice steps; CODE_MAP / BRAIN / DECISIONS / README true; the
    "Not built yet" list in CODE_MAP rewritten to what is actually left.
