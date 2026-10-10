# Maka — kickoff brief (revised 2026-10-10 after owner scoping)

## What Maka is
A local-first macOS app where a user runs a crew of real AI agents that operate an online
business for them, with as little hands-on time as the user chooses to give. The agents and
their work are rendered as a living national park: the user is the Superintendent, the agents
are Rangers, and the park layout IS the org chart and the permission model.

Modeled on StarNet (github.com/androoAGI/starnet, MIT, Andrew Sims) in architecture, built
from scratch under the name Maka. No StarNet source copied wholesale; any adapted snippet is
recorded in NOTICE.md. Maka must not be mistakable for StarNet visually or by name.

## Owner decisions (2026-10-10)
- Platform: macOS software distributed directly as a signed, notarized .dmg from Maka's own
  site. NOT the App Store; no App Store review or sandbox rules apply. Gatekeeper still
  requires Developer ID signing + notarization for a clean install. Apple Silicon first.
  Language is open; the settled choice is a Node sidecar (already built) inside a Tauri 2
  shell, with native Swift only where macOS needs it (Keychain, login item, menu bar).
- Theme: a NATIONAL PARK. Not a workshop, not a space station.
- Mission: a powerhouse for running online businesses autonomously, EVERY kind: online ads,
  Etsy and Shopify stores, dropshipping, affiliate and digital products, content and
  marketing, and finding new ways to make money by itself: studying what is publicly working
  for others and proposing and launching ventures. The user supervises from the park.
- Autonomy: the owner's goal is "free of touch, fully autonomous". See the Autonomy section
  for how Maka gets there without a single bad run draining an account.

## Product laws (non-negotiable)
1. Truthful telemetry: the UI never asserts state the harness cannot prove. Revenue, spend,
   orders, and messages shown in the park come only from connected real sources (Stripe,
   Shopify, email, ad accounts, the model-cost ledger). Never projected, never simulated.
2. Layout is the org: a zone is a capability-scoped team, a placed fixture is a real tool or
   connector grant, a trail is an authorized handoff between zones.
3. Secrets live in the sidecar and the macOS Keychain, never in the frontend.
4. Ask, don't guess: an agent turns ambiguity into one concrete question with options.
5. Finished work has a front door: deliverables land as real files and real records, not chat.
6. No outcome promises in product copy. Maka shows what the agents did and what it cost.
   It never claims or implies guaranteed income.

## The park (national park metaphor, data-driven so it can be re-skinned)
| Park element | What it is in the harness |
| --- | --- |
| Superintendent | the user |
| Ranger | an agent: own workspace, transcript, memory, bounded permissions |
| Ranger Station | HQ zone: orchestration, task briefs, the daily plan |
| Visitor Center | comms zone: inbox, customer messages, the outbox counter |
| Campground | an agent's working area; one campsite per active run |
| Lookout Tower | monitoring: live runs, spend, alerts, what needs the Superintendent |
| Trail | a handoff lane between zones; work items travel along it |
| Entrance Gate | the consent and spend rail; nothing with money or outbound effect passes without a grant |
| Fixtures (grants) | Trailhead sign = web fetch; Supply cache = filesystem; Radio tower = email/channels; Park Store = commerce connectors (Shopify/Stripe); Notice board = social/publishing; Fee booth = payments; Ledger desk = accounting |
Visual style: hand-drawn-feel pixel art, calm palette (greens, stone, sky), day/night cycle
driven by the real clock. Weather is purely cosmetic and must never encode state.

## Autonomy model (how "fully autonomous" is reached safely)
- Every Ranger has a leash level per domain: Observe → Draft for review → Act with cap →
  Act freely. Levels are set by the Superintendent and can be earned: a Ranger that
  completes N reviewed actions in a domain without a rejection gets a proposal to loosen.
- Domains: outbound messages, publishing, money out (ad spend, refunds, purchases), money in
  (pricing, invoicing), data deletion, account settings. Each is a separate leash.
- Defaults for a new park: everything at "Draft for review" except read-only research,
  which is "Act freely". Money out starts with a hard per-day cap even at "Act with cap".
- Away mode (the owner's "free of touch"): the Superintendent sets leashes, leaves, and
  every action taken while away is logged with evidence and shown at the Lookout Tower on
  return. Nothing is hidden, and any action can be rolled back where the connector allows.

## Business scope (owner decision 2026-10-10): every online business
The harness is vertical-agnostic. Ranger roles for phase 2, each a persona + loadout + leash
set, not hard-coded logic:
- Scout Ranger: finds opportunities. Studies publicly visible success stories, trends, and
  niches; produces a venture brief with evidence, costs, and a go/no-go the judge reviews.
- Storefront Ranger: runs Etsy / Shopify / dropshipping stores: listings, pricing proposals,
  supplier orders, fulfilment status.
- Ads Ranger: creates and manages campaigns (Meta, Google, TikTok), reports real spend and
  results, proposes budget changes behind the money-out leash.
- Marketing Ranger: content, social, email campaigns, SEO.
- Support Ranger: customer email and chat, returns, reviews.
- Books Ranger: orders, refunds, fees, daily P&L from real connector data only.
Connectors arrive in the order the owner's first venture needs them; email, Etsy, Shopify,
Stripe, Meta Ads, Google Ads are the first candidates.

## Conduct rules for autonomous business (product laws 7-9)
7. Platform-compliant by construction: every connector action goes through the platform's
   official API or an explicitly granted browser session, under that platform's terms. No
   scraping that a platform forbids, no review manipulation, no fake engagement. A banned
   account is the fastest way to zero revenue, so compliance is a money rule, not a legal
   footnote.
8. Replicate strategies, not property: the Scout studies what works and Rangers build
   original listings, copy, and creative. No copied listings, images, or brand names, no
   impersonation, no counterfeit or restricted goods.
9. Money-out actions (ad spend, supplier orders, refunds, subscriptions) always pass the
   Entrance Gate under the leash model, with a hard daily cap that only the Superintendent
   can raise.

## Model strategy (owner decision 2026-10-10): local workers, Claude as judge
- Two tiers. WORKER models are local open-weight models served by Ollama (or any
  OpenAI-compatible local endpoint) at zero marginal cost, so Rangers can run 24/7.
  The JUDGE is Claude via the Anthropic API, used sparingly for the steps where quality
  decides the outcome: planning a task brief, reviewing a worker's result before it passes
  the Entrance Gate, resolving an ambiguity, and any action at leash level "Act with cap"
  or "Act freely" in a money or outbound domain.
- Routing is explicit, per step, in the sidecar: every run records which model did which
  turn and what it cost. The park shows worker vs judge activity distinctly (a Ranger
  radios the Ranger Station when the judge is consulted).
- The judge never silently rewrites a worker's output; it returns approve / revise-with-
  notes / reject, and a reject or revise goes back to the worker as a new turn. Caps on
  judge calls per run and per day are part of the spend rail.
- Honest caveat recorded for the user: local models are smaller and need tool-calling
  support (`ollama show <model>` lists it); long tasks need a large context window and a
  machine with enough unified memory. The judge pattern catches errors, it does not make a
  weak worker strong. Maka reports worker model quality from real outcomes (judge verdict
  rates), never from benchmarks.
- Phase 1 addition: an `ollama` provider (OpenAI-compatible chat completions with tools at
  127.0.0.1:11434) alongside Anthropic and OpenRouter, and a `router.js` that picks the model
  per step from a policy object. Phase 2 adds the judge step in the loop and the verdict
  ledger.

## Stack
- ONE Node process (`sidecar/`): HTTP + SSE, static frontend, agent loop, providers,
  capability gate, connectors, atomic on-disk persistence. Node core modules only.
- `frontend/`: vanilla JS, no build step, canvas park + windowed UI.
- `shared/`: frozen schema-validated event contract. Additive only.
- `src-tauri/`: Tauri 2 macOS shell, Keychain-backed secrets, bundled Node. Phase 3.
- Tests: `node --test`; `npm run test:fast` is the merge gate.

## Phase 1 (foundation) — steps 1-6 done, 7-8 remaining
6b. `sidecar/providers/ollama.js` + `sidecar/router.js` per the Model strategy section, with
   tests using the fake provider; no real model needed.
7. Frontend: canvas park with the Ranger Station zone and one Ranger whose body visibly
   reflects real run state (idle / thinking / tool running / waiting on you / done / error),
   build mode to place fixtures, a COMMS window with streaming output, a spend readout fed
   only by reconciled cost events, and a permission prompt card at the Entrance Gate.
   Rename the theme data from workshop to park; keep theme data-driven.
8. `test/fast.list` complete, README and CODE_MAP true to what exists.

## Phase 2 (the business crew)
- Leash model from the Autonomy section, enforced in the capability gate, visible at the Gate.
- Multiple concurrent Rangers with separate workspaces; trails as real handoff queues.
- Connectors: email (IMAP/SMTP) first, then Shopify and Stripe read paths, then write paths
  behind leashes. MCP client for everything else.
- Task briefs, the daily plan at the Ranger Station, the Lookout Tower with real ledgers.
- Away mode with the evidence log.

## Phase 3 (the macOS app)
Tauri 2 shell, Keychain secrets, signed and notarized build, auto-update, first-run flow:
paste a key or sign in, a Ranger is already standing at the Ranger Station, say what the
business is.

## Not now
Windows/Linux, voice, computer control, Telegram/Discord/Slack, a hosted backend, accounts,
a marketplace. Stubs are documented in CODE_MAP.md, never faked in the UI.

## Working rules
- Small reviewable commits; push to main after each step; test:fast green before every push.
- Never commit keys; `.env*`, `*.key`, `secrets/` gitignored from commit 1.
- CODE_MAP.md, docs/BRAIN.md, docs/DECISIONS.md stay true to what exists.
