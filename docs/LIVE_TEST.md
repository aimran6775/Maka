# Live test runbook (phase 2)

How to prove the phase 2 chain against the real services: Claude (judge and Chief), a
local worker (Ollama) or the Hugging Face hosted worker, Resend and Cloudflare (mail),
and, when the owner has them, Stripe, Shopify, Etsy, Meta Ads, Google Ads, Brave Search
and a real Chromium. The automated suite (`npm run test:fast`) and the demo
(`npm run demo`) use fakes under `test/helpers/`; the sidecar itself never does. There is
nothing to "disable": start the sidecar and it talks to the real endpoints named in
`sidecar/**` (`RESEND_BASE_URL`, `CLOUDFLARE_BASE_URL`, `STRIPE_BASE_URL`, …).

Every step below says what to do and what the park, an event or a file must show. If a
step does not show it, stop: the UI shows only what an event proved, so a missing row is
a real gap, not a rendering delay.

## 0. Before you start

- Node 22+, a Chromium (Chrome, Chromium or the Playwright build), Ollama running with a
  model pulled (`ollama pull qwen2.5:7b`, say) or `HF_TOKEN` for the hosted worker.
- A fresh home: `export MAKA_HOME=$HOME/maka-live` (the keystore, layout, ledgers and
  policy live there) and a workspace: `export MAKA_WORKSPACE=/Volumes/LaCie/Maka/workspace`
  (or any writable directory).
- Secrets as environment variables (never in git, never typed into the park unless the
  step says the Gate stores them in the 0600 keystore):

  | Variable | Used by | Needed for |
  | --- | --- | --- |
  | `ANTHROPIC_API_KEY` (or `OPENROUTER_API_KEY`) | judge, Chief, reflection, mail classification on doubt | every step |
  | `OLLAMA_HOST` (default `http://127.0.0.1:11434`) | the worker tier | Ranger runs |
  | `HF_TOKEN` | the `hosted_worker` tier (step 8) | the Hugging Face step |
  | `RESEND_API_KEY` | mail: domain records, receiving, sending | steps 4–6 |
  | `CLOUDFLARE_API_TOKEN` (account-scoped) | mail DNS plan / apply | step 4 |
  | `RESEND_WEBHOOK_SECRET` | the Resend webhook route (optional; polling works without it) | step 5 |
  | `STRIPE_API_KEY` | Stripe sync and refunds | step 10 |
  | `SHOPIFY_ACCESS_TOKEN` + `SHOPIFY_SHOP` | Shopify | step 11 |
  | `ETSY_CLIENT_ID` | Etsy (then a sign-in at the Peak) | step 11 |
  | `META_ACCESS_TOKEN` + `META_AD_ACCOUNT_ID` | Meta Ads | step 12 |
  | `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CUSTOMER_ID` | Google Ads (then a sign-in at the Peak) | step 12 |
  | `BRAVE_SEARCH_API_KEY` | `web.search` through the API (the browser is the fallback) | step 13 |
  | `CHROMIUM` | the browser binary when it is not in a known location | step 9 |
  | `MAKA_BROWSER_HEADLESS=1` | only on a machine without a display (handoffs cannot be done headless) | — |

- `$MAKA_HOME/config.json` (optional): `{ "mailDomain": "makapark.com", "connectors": { "shopify": { "shop": "yourshop" }, "meta_ads": { "adAccountId": "act_…" }, "google_ads": { "customerId": "123-456-7890" }, "oauthPort": 8765 }, "browser": { "headless": false } }`.
  The OAuth redirect `http://127.0.0.1:8765/callback` must be registered with Etsy and
  Google for their apps.
- `$MAKA_HOME/policy.json` (optional) to route the worker to Hugging Face: see step 8.

Start: `npm start`, open `http://127.0.0.1:7777` (the port the console prints). The console
lists what is wired: providers, mail keys, connectors, the browser, the research kit.

## 1. Keys and the park

- Click the Peak. "judge today" names the Claude model and the $10/day cap. "research"
  names the search provider. "connectors" lists every platform with "connected" or "not
  connected" and the reason. "browser" names the Chromium found.
- `GET /api/state` → `providers.anthropic.configured: true`, `mail.keys`,
  `connectors[]`, `browser.wired`, `research.searchKey`.
- Nothing shows a number that no sync produced: a fresh park says "not synced yet".

## 2. Mission → plan → crew (real Claude)

- Peak → write a mission (one small venture, budget $3, horizon 30 days) → "Brief the
  Chief". The Chief's run appears on the Peak on `claude-opus-5-5` (step `plan`).
- Expect, in order: `plan.updated { change: 'submitted' }` (the plan card fills),
  `crew.agent { change: 'created' }` per hire (bodies appear in the camps),
  `work.handoff` per delegation (a Ranger walks a trail), `cost.estimate { tier: 'judge' }`
  with real token counts and a USD figure.
- Check: `$MAKA_HOME/plan.json` exists; the Chief's outbox has `plan-v1.md`.

## 3. A Ranger run with the judge (real Claude + Ollama)

- Place a Supply cache in the camp the Chief delegated to (BUILD). The Ranger's run uses
  the worker tier (Ollama; its cost events are unpriced and say so) and the judge reviews
  the final answer: `judge.verdict { scope: 'final' }` on the Ranger card.
- A file write asks at the Gate (`permission.prompt`); allow it; `work.done` lists the
  deliverable and the Ranger walks to the Visitor Center.
- Check: `workspace/<ranger>/outbox/` holds the file; the Peak's spend equals the sum of
  the priced `cost.estimate` events (`GET /api/state` → `spend`).

## 4. Mail DNS (Resend + Cloudflare)

- Peak → "Plan DNS": `mail.dns { change: 'planned' }` with create / update / unchanged
  counts, read from Resend's domain API and the Cloudflare zone. Nothing is written.
- "Apply DNS (via the Gate)": a Gate card in account_settings; approve it. Expect
  `mail.dns { change: 'applied' }`; the Cloudflare dashboard shows the MX, SPF, DKIM, DMARC
  and return-path records; Resend's domain page shows "verifying" then "verified".

## 5. Receive mail (Resend)

- Send an email from any mailbox to `visitors@<mailDomain>` (or a station address).
- Within `mailPollMs` (60 s default), or at once with `POST /api/mail/sync`, expect
  `mail.message { direction: 'in' }` and `mail.classified` (worker, judge when unsure).
- Visitor Center card: the thread appears with its classification. With
  `RESEND_WEBHOOK_SECRET` and a tunnel to `/api/mail/resend/webhook`, delivery is instant.

## 6. Send mail (Resend, the policy, the judge)

- Place a Radio tower in a camp; brief its Ranger: "reply to the latest visitor mail".
  The reply is outbound_messages at Draft → a Gate card with the draft; approve.
- Expect `mail.message { direction: 'out' }`, then `mail.event { delivered }` from Resend's
  events; the Visitor Center outbox shows "delivered". A send to a never-seen address also
  shows a `judge.verdict` (judgeAtDraft).
- Try a campaign at act_free to a list: the footer and List-Unsubscribe header are on the
  received mail; `unsubscribe@` adds the sender to the suppression list.

## 7. Away mode and the evidence log

- Peak → "I'm away". Approve or reject one Gate item. "I'm back" → `away.digest` and a
  digest file next to `workspace/_peak/away-log.ndjson` naming that decision.

## 8. Hugging Face hosted worker

- `$MAKA_HOME/policy.json`: `{ "version": 1, "tiers": { "worker": { "provider": "ollama" }, "judge": { "provider": "anthropic", "model": "claude-sonnet-5-5" }, "hosted_worker": { "provider": "huggingface", "model": "Qwen/Qwen2.5-72B-Instruct" } }, "steps": {}, "fallback": { "worker": "hosted_worker" } }`.
- Stop Ollama. Brief a Ranger: the run starts on tier `hosted_worker` (the Ranger card
  shows `hosted_worker · huggingface/Qwen/…`), its cost events are unreconciled, and the
  Peak's judge row shows the hosted call count against `hostedWorkerCallsPerDay`.
- Start Ollama again: the next run is back on the worker tier. No run ever moved to
  Hugging Face without the `fallback` line.

## 9. The browser and a handoff (real Chromium)

- Place a Field office in a camp. Brief its Ranger: "open https://example.com and read
  it"; browser_control at Draft → a Gate card per action; approve. The Ranger card shows
  "open at …"; `workspace/<ranger>/browser-trace/` fills with a trace line and a PNG per
  action.
- Brief: "open <a site's sign-in page>". A BROWSER HANDOFF card appears at the Gate and
  the window comes to the front; sign in yourself, add a note, "Hand back". The run
  continues and the tool result carries your note. Brief the same Ranger again later: the
  profile kept the session (no second handoff on that site).

## 10. Stripe

- With `STRIPE_API_KEY` set, the Finance camp card shows the balance, charges, payouts and
  refunds from the boot sync (`connector.sync { status: 'done' }`). Place a Fee booth; brief
  a Books Ranger: "refund $1 of the latest test charge". A Gate card in money_out with
  $1.00; approve. The Stripe dashboard shows the refund with metadata `by: maka:<ranger>`.

## 11. Shopify and Etsy

- Shopify (token + shop) syncs at boot; the Listings camp card lists products, orders and
  stock. Place a Park Store; brief a Storefront Ranger to draft a product: publishing at
  Draft → Gate → approve → the product appears in the Shopify admin as a draft.
- Etsy: Peak → "Connect (sign in, via the Gate)" → approve → open the sign-in link →
  consent on Etsy → the local callback stores the token → `connector.sync` done. A price
  change through `etsy.set_price` is money_in at the Gate.

## 12. Meta Ads and Google Ads

- Meta (token + ad account) syncs at boot; the Marketing camp card shows campaigns and the
  last 7 days. Place a Notice board; brief an Ads Ranger to "create a $1/day campaign,
  paused": money_out at the Gate with $1.00; approve; the campaign exists PAUSED in Ads
  Manager.
- Google Ads: Peak → sign in (offline access is requested, a refresh token comes back) →
  sync. A budget change is money_out with the new daily amount at the Gate.

## 13. The Scout and a venture brief

- Place a Trailhead sign in the Research camp. Brief a Scout: "research <niche> and
  submit a venture brief". Expect `web.search` results (via Brave when the key is set,
  else through the Field office browser), `web.read` articles, `web.trends` with Wikipedia
  and Hacker News figures, then `brief.submit`: `judge.verdict` with `tools: ['brief.submit']`,
  the brief under `workspace/<scout>/outbox/briefs/`, listed at the Peak with the verdict,
  and the Chief's follow-up run deciding go / no-go.

## 14. Reflection

- Peak → "Reflect now". `reflection.posted` names the ventures and the camps briefed; the
  document under `$MAKA_HOME/reflections/` cites the Stripe / Shopify / ads figures from
  the syncs and the judge spend; `workspace/_stations/<camp>/notes/` gets a briefing, and
  (phase 4) the camp's station mailbox gets it as a `briefing` from peak@: click the camp,
  the inbox lists "Briefing from the Mountain Peak" marked briefing, with no Resend send.

## 15. Headless park check

- `CHROMIUM=<binary> node scripts/park-check.mjs` opens the park in headless Chromium
  against a scripted sidecar and prints `PARK CHECK OK` with the crew's bodies and no
  console errors. Run it after any frontend change.

## 16. Telegram (phase 4)

- Make a bot with @BotFather, `export TELEGRAM_BOT_TOKEN=<token>`, start the sidecar: the
  boot log says `channels: Telegram up (env, long polling as @<bot>)` and the Peak's "owner
  channels" row says the same.
- Peak → "Pairing code"; send the code to the bot from your own chat within ten minutes.
  `channel.inbound { action: 'pair', outcome: 'paired' }`, the bot answers "Paired with the
  Mountain Peak", the Peak lists the chat with Unpair.
- Run step 3's Ranger action again: the Gate card reaches the chat with Approve / Revise /
  Reject (`channel.delivery { kind: 'gate_card', status: 'sent' }`); press Revise, send the
  notes; `gate.item { revised }` carries them and the Ranger's next turn sees them.
- From another chat, send the bot anything: it answers "not paired" once and
  `channel.inbound { paired: false }` is logged; a button press from it is refused.
- Write a question: a Chief run with no tools (`agent.run.start` lists `tools: []`),
  the answer in the chat with `Evidence: run <id>`, counted in the judge's day.

## 17. Discord and Slack (phase 4)

- Discord: an application with a bot, the bot token in `DISCORD_BOT_TOKEN`; no privileged
  intent is needed (DMs only). Open a DM with the bot, send the pairing code from the Peak;
  the Gate card arrives with Approve / Revise / Reject buttons; a press is acknowledged
  at once and `channel.inbound` records the decision.
- Slack: an app with Socket Mode on, a bot token (`chat:write`, `im:history`,
  `im:read`) in `SLACK_BOT_TOKEN` and an app-level token with `connections:write` in
  `SLACK_APP_TOKEN`; the Events API subscription `message.im`. The boot log says `Slack up
  (env, socket mode as <bot> in <team>)`; with only one of the two tokens it says `not
  wired (SLACK_APP_TOKEN)`. Pair from a DM with the app and repeat the card step.
- BUILD → place a Radio tower in the Mountain Peak zone: its lamps are green for every
  channel that is up and dark for the rest; click it for the list.

## 18. MCP (phase 4)

- Peak → "Add a stdio server": name `files`, command `npx -y
  @modelcontextprotocol/server-filesystem <a scratch directory>`. The Gate item names the
  command; approve it. `mcp.server { configured }` then `{ connected, tools: N }`; the row
  lists the tools with clipped descriptions, `read_file` and friends as research (read-only
  hint) and the writes as outbound_messages.
- BUILD → Outpost in the Research camp → pick `files` (the prompt lists every tool and
  domain). Brief the Scout to list that directory: `agent.run.start` lists
  `mcp.files.list_directory`, the call runs as research; a write waits at the Gate.
- Peak → "Add an HTTP server" with a remote server that requires OAuth: the row says
  `needs_auth`; "Sign in (via the Gate)" → approve → open the link → the row turns
  `connected` and the token is in the keystore under `mcp.<id>`.
- Try `http://127.0.0.1:…/mcp`: the add is refused by the outbound guard (NET_GUARD).
- Peak → Catalog → Brave Search → Add: paste the key; the Gate item names `npx -y
  @modelcontextprotocol/server-brave-search@latest` and the key is nowhere in it; approve;
  `brave_web_search` lands as research as the catalog proposed.

## Cleaning up

Disconnect connectors at the Peak (Gate items), remove the test campaign, product and
refund on each platform, and delete `$MAKA_HOME/keystore.json` if the keys were stored
there. Environment variables Maka cannot unset: unset them yourself.
