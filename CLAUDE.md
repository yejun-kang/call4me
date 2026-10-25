# CLAUDE.md — call4me

This file gives Claude Code the full context for this repo. Read it before every task. When something here conflicts with a request, ask before deviating.

It describes the project **as built**. The plan changed during the hackathon (Twilio → Cartesia agents, native iOS → mobile web app, Convex storage → always-on backend); section 20 lists what changed and why.

**Current production architecture:** [nautical-wolverine-162.convex.site](https://nautical-wolverine-162.convex.site/) serves the static app, call API, Cartesia webhooks and tools from Convex. Cartesia runs the voice call; Convex stores call state and streams updates. No laptop server, tunnel or Azure service is in this production path. See [Convex always-on deployment](docs/convex-always-on.md). The Python/FastAPI, phone-mode and Azure instructions below describe the retained legacy implementation, not a requirement to deploy on Azure.

---

## 1. What we're building

**call4me** is a mobile web app plus a voice agent that makes a customer service phone call for the user, start to finish. It navigates the phone menu, waits on hold, talks to the human rep to reach the user's goal, and pulls the user in only when it needs something only they know (order number, PIN, a decision).

**Who it's for (named community):** Deaf and hard-of-hearing adults who face phone-only customer service. Relay services exist but involve waits, interpreters, and staying present through hold. call4me lets them handle the whole call by reading and typing.

**One-line pitch:** "Deaf people can't use phone-only customer service. Now they can, by typing."

**Context:** built at Cal Hacks 13.0 (Oct 23–25, 2026, San Francisco). Submission deadline: 8:30 AM Sunday. Judging is a 3-minute pitch + 2-minute Q&A at our table.

### Target tracks (and what each one judges)
- **Anthropic — Claude for Public Benefit:** named community; a real problem (we talked to people who have it); it works (one thing done well, usable Monday); thoughtful use of Claude, including where it could go wrong for these users.
- **Microsoft — Built for the Real World:** customer understanding; measurable usefulness; path from prototype to production; responsible design; end-to-end functionality. The legacy Azure deployment uses Container Apps, Key Vault, Application Insights and PostgreSQL.
- **Cartesia:** voice is the core of the product. Real calls are placed and run by a Cartesia Managed Agent; phone mode uses Cartesia speech-to-text and Sonic text-to-speech.
- Secondary: Cal Hacks social impact prize (if offered), Figma Best Design (if screens are designed in Figma).

---

## 2. Non-negotiable rules (product and safety)

1. **AI disclosure:** the agent always identifies itself as an AI assistant calling on behalf of the user, using the user's chosen wording, at the start of any human interaction.
2. **Do not persist raw private answers.** Legacy Python answers stay in memory. The user-approved Convex flow briefly stores AES-GCM-encrypted answers, deletes them when the waiting tool consumes them, and schedules cleanup of abandoned values. Keep answers out of ordinary call records and audit payloads. Convex caption redaction currently recognizes emails and numeric strings of four or more digits; it is not a guarantee that arbitrary private text or spoken-out digits are removed. See the deployment guide for retention details.
3. **The agent never invents user facts.** It only speaks information the user provided or the session goal contains. Otherwise it must call `ask_user`.
4. **High-sensitivity items** (full SSN, full card number, passwords): do not relay via the agent. The user provides them another way.
5. **Limits are enforced outside the model.** The agent cannot agree to anything outside the user's stated goal and limits (new plans, fees, cancellations not requested). Blocked attempts are logged.
6. **User can take over at any time.**
7. **All user alerts are visual or haptic,** never sound-only (the users are Deaf/HoH).
8. **No recordings stored by default.** Process audio live. California requires all-party consent for recording.
9. **Append-only audit log.** Every state change, decision, denial, and tool call is logged with reason and confidence. Fixes are new events, never edits.

### How each rule is enforced, by mode

| Rule | `phone` mode (our pipeline) | `cartesia` mode (real calls) |
|---|---|---|
| 1 Disclosure | Guard prepends it if missing | In the agent's instructions; the agent speaks it |
| 2 Redaction | `audit/log.py` before every log, DB write, live message, telemetry | Convex uses the pattern-based redaction described above; legacy Python uses `audit/log.py`. Cartesia sees answers to relay them; deletion is attempted at call end and retried on failure |
| 3 No invented facts | Prompt + `ask_user` tool | Prompt + `call4me_ask_user` tool |
| 4 High sensitivity | Guard blocks relay; `request_takeover` | Instructions + `ask_user` with `sensitivity=high` returns no value; the web app shows **Say it myself** |
| 5 Limits | Guard checks every outgoing line in code | Agent is told to call `call4me_check_offer`, which decides in code; nothing can block a sentence before Cartesia's agent says it |
| 6 Takeover | Agent stops speaking immediately; the user's typed lines are spoken verbatim | A Cartesia agent can't be muted from outside: typed lines are queued and the agent says them word for word on its next tool call |
| 9 Audit | Append-only `audit_log` | Same |

Be honest about this split in the pitch and in code comments: the strongest guarantees are in phone mode.

---

## 3. Architecture

Current production: phone browser → Convex HTTP actions + subscriptions → Cartesia managed agent. `convex/phone.ts` handles calls and tools; `convex/jev.ts` asks TypeSafe for menu and state decisions; `convex/jevWatch.ts` runs background state checks from company captions; `convex/managed.ts` records state and decisions; `convex/site.ts` serves the static export from file storage.

The retained **legacy Python/Azure architecture** is:

```
Phone browser: mobile web app (/)          Judges view (/dashboard/)
  │  REST + WebSocket (Bearer API_TOKEN)        ▲
  │  or Convex subscription (optional)          │
  ▼                                             │
Backend (Python, FastAPI) on Azure Container Apps, exactly 1 replica
  ├─ serves the web app (static Next.js export) at /
  ├─ Session API + live feed (WS /calls/{id}/live, replay on reconnect)
  ├─ Storage: PostgreSQL (default) or Convex (STORAGE_BACKEND=convex)
  ├─ Guard + audit log + redaction (in code)
  ├─ Key Vault (secrets) · Application Insights (redacted logs)
  │
  ├─ TELEPHONY=cartesia (default, real calls)
  │    Cartesia Managed Agent dials the company from our Cartesia number,
  │    listens, thinks (Claude via Cartesia), speaks, presses keys.
  │    We get every utterance by webhook (POST /cartesia/webhook) and answer
  │    its tools (POST /cartesia/tools/{name}): ask_user, check_offer,
  │    menu_choice, report_state, finish. Jev chooses menu options;
  │    the managed agent presses keys with its built-in send_dtmf tool.
  │    Jev also watches company captions before a person answers.
  │
  └─ TELEPHONY=phone (backup demo, no phone network)
       Our own pipeline against the fake support line:
       audio → VAD + music classifier → Cartesia STT → state engine (Jev)
       → Claude tool-use loop → guard → Cartesia TTS.
       Whoever opens /phone in a browser is the rep.
```

With `USE_MOCKS=true` every external service is mocked and calls go to an in-process fake line (tests, evals, local dev).

### Who does what
- **Cartesia:** in `cartesia` mode, the whole call (telephony, listening, speaking, DTMF) via a Managed Agent whose model is Claude (`CARTESIA_AGENT_MODEL`, default `claude-haiku-4.5`). In `phone` mode, ears (STT) and voice (Sonic TTS).
- **Claude:** the conversation with the rep in both modes (through Cartesia's agent, or our own tool-use loop via the Anthropic API in phone mode, default `claude-sonnet-5-5`), the greeting, caption summaries, and the post-call summary.
- **Jev (TypeSafe):** typed decisions with probabilities in both modes. Managed Cartesia calls use `call4me_menu_choice` for menu options and a background watcher for company captions before a person answers. The legacy `phone` pipeline also uses audio labels, periodic state checks and human confirmation. Production reads `TYPESAFE_API_KEY` from Convex; a missing key, provider error or two-second timeout falls back to keyword heuristics. Convex events record `source: "jev"` or `source: "heuristic"` plus a fallback reason, so a successful tone does not by itself prove Jev chose it.
- **Convex:** production hosting, HTTP actions, call state and live subscriptions. It is also an optional store for the legacy Python worker when `STORAGE_BACKEND=convex`. See section 9.
- **Azure (legacy):** hosting, PostgreSQL, Key Vault, Application Insights. `AZURE_FOUNDRY_*` settings exist but Claude is not routed through Foundry.

---

## 4. Tech stack

| Layer | Tool |
|---|---|
| Backend | Convex TypeScript HTTP actions in production; Python 3.11+/FastAPI for legacy modes |
| Storage | Convex in production; PostgreSQL + SQLAlchemy or Convex for the legacy Python worker |
| Telephony | Cartesia Managed Agents (real calls); `/phone` browser page + mock line (backup) |
| Speech | Cartesia STT and Sonic TTS (phone mode); Cartesia agent voice (`CARTESIA_VOICE_ID`) |
| Decisions | Jev `jev-latest` via the TypeSafe Choice HTTP API in Convex; `typesafe-sdk` in the legacy Python modes |
| Conversation | Claude via the Anthropic SDK (tool use) |
| Audio | numpy, soxr; energy VAD and a time-domain music/speech classifier (lightweight stand-ins for Silero and YAMNet) |
| Web app | Next.js (App Router, TypeScript) + Tailwind, static export in `web/out` |
| Hosting | Convex HTTP actions and file storage; retained Azure Container Apps deployment for the legacy worker |
| Dev | cloudflared tunnel for Cartesia webhooks, Docker Compose, pytest, vitest |

**Do not deploy the legacy Python worker as short-lived serverless handlers.** Its WebSocket and in-memory call state need one long-lived process. This restriction does not apply to the Convex implementation, which persists state between HTTP actions while Cartesia owns the live call.

---

## 5. Repo layout

```
call4me-team/
├─ CLAUDE.md · README.md · TEAM.md
├─ .env.example                # every setting, with comments
├─ docker-compose.yml          # local Postgres
├─ Dockerfile                  # Node stage builds web/, Python stage runs the API
├─ backend/
│  ├─ main.py                  # FastAPI app, routes, serves web/out at /
│  ├─ config.py                # env + Key Vault loading
│  ├─ auth.py                  # API_TOKEN check
│  ├─ contracts.py             # shared types
│  ├─ calls.py                 # starts calls; LiveCall = phone/mock pipeline
│  ├─ cartesia/                # cartesia mode: agent spec + setup, webhook/tool routes, CartesiaCall
│  ├─ db/                      # models, SQL session, store.py (SQL or Convex), convex_client.py
│  ├─ telephony/               # phone_client (/phone page), mock_client (in-process line)
│  ├─ audio/                   # codec, resample, VAD, music classifier, echo
│  ├─ speech/                  # Cartesia STT/TTS, playback
│  ├─ engine/                  # states.py, call_engine.py, jev_checks.py, menu.py, timers.py
│  ├─ agent/                   # Claude tool-use loop, tools, prompts, guard
│  ├─ notify/                  # live hub, Convex live writer, APNs (unused without a paid Apple account)
│  ├─ audit/log.py             # append-only audit log, redaction
│  └─ telemetry.py             # Application Insights (redacted)
├─ web/                        # mobile web app + judges view
├─ convex/                     # production HTTP API, static hosting, call state, storage, live replay, cleanup
├─ fakeline/                   # fake company script, menus, hold audio
├─ dashboard/                  # backup console (/console/) and rep page (/phone)
├─ evals/                      # scenarios, simulator, bot rep, scoring, results/
├─ scripts/                    # Convex smoke test, subscription check, SQL → Convex copy
├─ infra/                      # Bicep + deploy.sh
├─ docs/convex-migration.md
├─ tests/
└─ ios/                        # shelved SwiftUI app (unmaintained)
```

Keep one responsibility per file. Put every external service behind a small client module with a mock twin (`USE_MOCKS=true`).

---

## 6. Call state machine

```
DIALING → MENU → HOLD ⇄ RECORDED_MESSAGE
            │        │
            │        ├→ CALLBACK_OFFERED
            │        └→ HUMAN_SUSPECTED → HUMAN_CONFIRMED → IN_CONVERSATION
            │                                                   │  ⇄ WAITING_ON_USER
            │                                                   ├→ TAKEOVER (user typing)
            │                                                   └→ ENDED
            └→ VOICEMAIL / FAILED / ENDED
```

Legacy Python transitions go through `engine/states.py`; Convex transitions use `convex/managed.ts`. Both record state changes in `call_event` and `audit_log`.

### Phone mode (`engine/call_engine.py`)
- Every 2–3 s, send the last transcript window + audio label to Jev (Choice): `menu | recorded_message | hold_music | silence | human | voicemail | callback_offer | call_ended`.
- **Timers:** menu loop > 3 repeats → press 0 / say "representative"; silence > 30 s → re-check; hold > user's max → ask the user whether to keep waiting (`POST /calls/{id}/hold`).
- **Transfers** ("please hold while I transfer you") return to HOLD.
- Pause STT during confirmed hold music (cost); keep the music classifier and Jev checks running.
- Working menu routes are saved per company (`menu_path`) and reused.

**Human detection (latency-critical):** Jev flags `human` with high confidence → play the **pre-generated** greeting → confirm by a natural response from the rep (recordings don't respond) → visual alert on the user's screen. Target: agent speaks within ~1.5 s of the rep's greeting.

### Cartesia mode (`convex/phone.ts`; legacy `backend/cartesia/call.py`)
- **Jev picks menu options:** the managed agent calls `call4me_menu_choice` with the options it heard. Convex asks TypeSafe which option fits the goal, records its probability and source, then returns the selected key or word. Cartesia invokes built-in `send_dtmf` (or says the requested word). The menu tool does not wait for a separate state classification before returning its action.
- Keypad requests use `send_dtmf` for known info or an `ask_user` answer with `delivery="dtmf"`. The agent is instructed not to narrate decisions to automated systems; `send_dtmf` and `skip_turn` have pre-tool speech off.
- **Jev watches company speech before a person answers:** the webhook schedules a check of the last four remote captions. Confident results update state (0.6 for automated states; 0.75 for a person). Once in conversation, the watcher stops until the agent reports a menu or hold again. Late results cannot overwrite newer company speech or state changes.
- **The agent also reports state:** it stays silent on hold (`skip_turn`) and calls `call4me_report_state` with `menu | hold | person`. The note is used as the transition reason; a conflicting recent confident Jev result produces a disagreement event rather than blocking the agent's report.
- Per-turn webhooks produce redacted live captions and record observed `send_dtmf` calls as `menu_action` events. Jev checks produce `jev_decision` events and `jev.decision` audit entries with confidence, source and fallback metadata. Convex deduplicates webhook turns when Cartesia supplies a turn ID.
- This restoration keeps Haiku 4.5, the existing voice, silent DTMF/PIN delivery and the mobile PIN keyboard behavior.
- `call_completed` / `call_failed` webhooks end the call. Production writes go directly to Convex; the legacy worker uses its selected SQL or Convex store.

---

## 7. Conversation agent

### Phone mode: our Claude tool-use loop (`agent/`)
Runs in `IN_CONVERSATION`. Each rep turn: final STT transcript → Claude → tool call → guard → action.

| Tool | Purpose |
|---|---|
| `say(text)` | Speak to the rep (passes through guard, then Cartesia TTS) |
| `ask_user(question, sensitivity)` | Pause and ask the user; `sensitivity ∈ {low, medium, high}` |
| `press_digits(digits)` | Send DTMF |
| `end_call(summary, reference_number)` | Finish: confirm details, thank rep, hang up |
| `request_takeover(reason)` | Ask the user to take over (e.g., high-sensitivity info) |

### Cartesia mode: webhook tools (`cartesia/spec.py`)
The agent's instructions carry the goal, limits, disclosure wording, info the user chose to share, and the rules above. Its five webhook tools call back into our server:

| Tool | Purpose |
|---|---|
| `call4me_ask_user(question, sensitivity, delivery?)` | Ask the user; waits up to ~95 s. Delivery defaults to speech; explicit keypad requests use `dtmf` |
| `call4me_check_offer(kind, description, amount_usd)` | Decide in code whether the limits allow a charge, plan change, cancellation, or anything outside the goal |
| `call4me_menu_choice(options)` | Ask Jev for a menu option; return the chosen key for native `send_dtmf` or a requested spoken word |
| `call4me_report_state(state, note)` | Update the user's screen: menu, hold, or person |
| `call4me_finish(summary, …)` | Record the outcome for the summary screen |
| built-in `send_dtmf`, `skip_turn`, `end_call` | Keys, staying silent on hold, hanging up |

Any tool result may carry a queued message the user typed; the agent says it word for word.

### `ask_user` flow (both modes)
For Cartesia keypad requests, skip the spoken holding line and relay the answer through `send_dtmf`. Menu/hold states remain unchanged while the user types; timeouts retry silently. The existing spoken-answer flow is:

1. Agent says a holding line: "One moment, let me check with my client."
2. State → `WAITING_ON_USER`; create `user_request` (question only).
3. The web app gets the question over the live feed: full-screen color flash + vibration where supported, big question, text input. The keyboard opens when the user taps the input; the sheet fits the visible area so the question, input, and **Send answer** remain accessible.
4. User answers → `POST /requests/{id}/answer` → encrypted mailbox in Convex (in-memory broker in Python) → relayed by the waiting tool. Redaction limitations are described in section 2.
5. No answer in time → ask the rep to hold briefly or offer to call back.
6. `sensitivity=high` → no answer box, only **Say it myself**.

### Prompting guidance
- Keep spoken turns short and natural. Never think out loud (in cartesia mode everything the agent writes is spoken).
- Confirm key details once before ending ("Just to confirm, the $40 fee is waived and the reference is A7X291?").
- Never state facts about the user's account that weren't provided.

---

## 8. Guard layer (`agent/guard.py`)

In phone mode every outgoing action passes through `guard.check(action, session)` before execution:
- Disclosure already given? If not, prepend it.
- Does the text contain stored private data? Block.
- Does it agree to anything outside goal/limits? Block, log denial, return reason to Claude.
- High-sensitivity relay? Block; trigger `request_takeover`.

In production, `convex/phone.ts` checks offer limits and high-sensitivity questions/answers. The legacy Cartesia worker uses `CartesiaCall._check_offer` and `looks_high_sensitivity`. Denied attempts are logged to `audit_log` with `allowed=false` in both implementations.

---

## 9. Data model and storage

Six shared record tables (same IDs and REST shapes in both backends):

- `call_session(id, user_id, company, phone_number, goal, limits_json, disclosure_text, state, started_at, ended_at, outcome, reference_number, minutes_saved)`
- `call_event(id, session_id, at, kind, from_state, to_state, confidence, detail_json)` — timeline
- `menu_path(id, company, steps_json, success_count, last_used_at)` — reuse working routes
- `user_request(id, session_id, question, sensitivity, status, created_at, answered_at)` — **never store the answer**
- `audit_log(id, at, actor, action, subject, allowed, reason, diff_json, evidence_json)` — append-only
- `device(user_id, apns_token, live_activity_token)` — kept for the shelved iOS app

**Convex production:** `managed_call` tracks provider calls; `answer_mailbox` and `typed_message` contain short-lived ciphertext; `site_asset` indexes static files; `live_message` holds replay. `user_request` itself never contains an answer. See [deployment and retention](docs/convex-always-on.md).

**Legacy backend selection:** `backend/db/store.py` picks SQL or Convex from `STORAGE_BACKEND` (default `sql`). Python business logic uses `open_store()`; keep raw SQL in the SQL adapter.

**Legacy Python worker with Convex storage** (`STORAGE_BACKEND=convex`, see `docs/convex-migration.md`):
- All six tables live in Convex; no PostgreSQL is used or provisioned.
- The web app subscribes to Convex for live captions and state (`NEXT_PUBLIC_CONVEX_URL` at build time) instead of the worker WebSocket. The last 400 redacted messages per call are kept up to 24 h for replay.
- A state change and its timeline/audit rows commit atomically; audit and timeline rows cannot be edited.
- Python still owns calls, call controls, the guard, and private answers. Answers and typed text go straight to the worker and are never sent to Convex.
- Still one worker replica: the in-memory call registry and answer broker are not distributed.

The earlier Azure deployment used `STORAGE_BACKEND=sql`; that does not select the current Convex production path.

---

## 10. API endpoints (backend)

The list below includes legacy endpoints. Convex production implements call controls, answers, companies, audit and Cartesia callbacks through HTTP actions and uses subscriptions for live updates. It does not host the legacy phone-mode WebSocket or device registration; `/metrics` currently returns no eval results. Managed calls do not support immediate takeover/handback.

- `GET /health`
- `POST /calls` — start a call `{company, phone_number, goal, limits, disclosure_text, known_info}` · `GET /calls` · `GET /calls/{id}` · `GET /calls/{id}/audit`
- `WS /calls/{id}/live` — captions, state, summaries, questions; replays recent messages on connect
- `POST /calls/{id}/takeover` · `POST /calls/{id}/handback` · `POST /calls/{id}/cancel`
- `POST /calls/{id}/type` — type-to-talk text (spoken verbatim)
- `POST /calls/{id}/hold` — keep waiting or stop after the max-hold alert
- `POST /requests/{id}/answer` — user's answer to `ask_user`
- `GET /companies?q=` — company directory
- `POST /devices` — APNs tokens (iOS app, shelved)
- `GET /metrics` — latest eval report (JSON; no longer shown on the dashboards)
- `POST /cartesia/webhook` · `POST /cartesia/tools/{name}` — Cartesia callbacks (tool-secret auth)
- `GET /phone` + `WS /phone/ws` — phone-mode rep page
- `/` — the web app; `/dashboard/` judges view; `/console/` backup console

Convex call APIs require `Authorization: Bearer <CALL4ME_VIEWER_TOKEN>`; Cartesia callbacks use their tool secret. The legacy Python deployment uses `API_TOKEN` (or `?token=` on WebSockets).

---

## 11. Mobile web app (`web/`) — Plan C

The native iOS app is shelved (`ios/` stays in the repo, unmaintained): a free Apple ID can't do push, installs expire every 7 days, and judges can't install it. Instead the user's phone runs a **mobile web app**, served by Convex over HTTPS. Any phone opens it from a link, and "Add to Home Screen" makes it look like an app.

- **Stack:** Next.js (App Router, TypeScript) + Tailwind, built as a static export (`web/out`) served by Convex in production or FastAPI locally. No Node server in production. Pages use query params (`/live/?id=…`), not dynamic segments.
- **Start (`/`):** company (from `GET /companies`), phone number, goal, limits, info the agent may share (values used once, never saved in the browser), AI introduction → `POST /calls`.
- **Live (`/live/?id=`):** large high-contrast captions and a state banner (with a hold timer) over `WS /calls/{id}/live` (or Convex). It reconnects automatically and rebuilds from the replay. Also shows plain-language summaries when emitted and Hang up.
- **Question sheet (`ask_user`):** full-screen color flash (a single color change with reduced motion) plus vibration where supported, a big question, and a text input → `POST /requests/{id}/answer`. It opens without focusing the input. Tapping the input opens the keyboard; the sheet follows the visible viewport, with a scrollable question and input/Send controls that stay above the keyboard. The input clears at once on send. For `sensitivity=high` there is no answer box, only **"Say it myself"** → takeover. It closes on the `ask_user_answered` live event.
- **Take over (type-to-talk):** `POST /calls/{id}/takeover`, then `POST /calls/{id}/type`. Quick phrases. Hand back with one tap. (Cartesia mode: see the table in section 2.)
- **Summary (`/summary/?id=`):** outcome, reference number (large, copyable), minutes saved.
- **Judges view (`/dashboard/`):** recent calls, a live call with its timeline and audit log (denials highlighted, private values shown as `[REDACTED]`).
- **Phone behavior:** Screen Wake Lock on the Live screen, a web app manifest for Add to Home Screen, large text (adjustable), big touch targets, plain short English.
- **Alerts are visual (+ vibration), never sound-only** (rule 7). Web push is a later stretch goal, so the app must be open during a call.
- **Access:** the API needs the access token (`CALL4ME_VIEWER_TOKEN` in Convex, `API_TOKEN` in Python). The app asks for it once, keeps it in localStorage, and sends it as `Authorization: Bearer` (or `?token=` on the legacy WebSocket).

---

## 12. Environment variables

Production Convex settings are listed in [the deployment guide](docs/convex-always-on.md). `.env.example` describes the legacy Python settings, including:

```
TELEPHONY=cartesia            # cartesia | phone | (empty: mock with USE_MOCKS, else cartesia)
PUBLIC_BASE_URL=              # public https URL for Cartesia webhooks (Azure URL or cloudflared)
CARTESIA_API_KEY=  CARTESIA_VOICE_ID=  CARTESIA_AGENT_MODEL=claude-haiku-4.5
TYPESAFE_API_KEY=             # Jev in both modes (keyword heuristics without it)
ANTHROPIC_API_KEY=            # Claude, phone mode
API_TOKEN=                    # empty = open (local dev); deploy.sh generates one
STORAGE_BACKEND=sql           # or convex (+ CONVEX_URL, CONVEX_BACKEND_TOKEN)
DATABASE_URL=  APPLICATIONINSIGHTS_CONNECTION_STRING=  AZURE_KEY_VAULT_URL=
USE_MOCKS=false
APNS_*                        # paid Apple account only; leave empty
```

Never commit secrets. Current production reads Convex environment variables, including `TYPESAFE_API_KEY`; changing a laptop `.env` does not change the deployed value. The legacy Azure worker loads secrets from Key Vault. After deploying the Convex endpoints, run `PYTHONPATH=. .venv/bin/python scripts/enable_cartesia_jev.py` for a dry run, then add `--apply` to restore the existing agent's menu-choice tool and instruction. See the deployment guide for the complete sequence.

---

## 13. Development workflow

1. `uv sync` · `TELEPHONY=mock uv run pytest -q` · `(cd web && npm ci && npm run build)`
2. All mocks: `TELEPHONY=mock USE_MOCKS=true uv run uvicorn backend.main:app --reload`, open `http://localhost:8000/`. Explicit mock telephony overrides any real-call mode in `.env`.
3. Phone mode: `docker compose up -d`, `TELEPHONY=phone uv run uvicorn backend.main:app --host 0.0.0.0 --port 8000`, open `/phone` (rep) and `/` (user). `uv run python -m evals.phone_rep` plays a scripted rep.
4. Cartesia mode: `cloudflared tunnel --url http://localhost:8000`, set `PUBLIC_BASE_URL`, start the server. On start it creates or updates the Cartesia agent, tools, webhook and phone number (`uv run python -m backend.cartesia.setup` does it by hand). Test by calling your own cell before any real company.

The fake support line (`fakeline/`): menu (1 orders, 2 billing, 0 agent), nested billing menu, recorded messages, hold music, occasional callback offer, then a rep (person on `/phone`, or the scripted bot rep).

---

## 14. Testing and evals

- **Unit tests:** `TELEPHONY=mock uv run pytest -q` (state transitions, guard rules, redaction, limits, full mock calls); `npm test` (Convex functions).
- **Eval suite (`evals/`):** 11 scripted scenarios on the fake line with a scripted bot rep — cancellation, fee waiver, order status, callback offer, transfer back to hold, menu loop, rep asks for PIN, rep offers paid upgrade, rep refuses to talk to AI, user takeover, rep asks for an SSN.
- `USE_MOCKS=false uv run python -m evals.run --driver product --guard real` runs our phone-mode pipeline with real Claude and Jev: `evals/results/product-claude.json` passed **11/11** with 0 safety violations. This measures phone mode, not the Cartesia agent.
- **Metrics:** success rate, avg minutes saved, # times asked user, errors, guard denials, time-to-greet. Saved in `evals/results/`; also served as JSON at `GET /metrics`.

---

## 15. Deployment (legacy Azure worker)

For current production use [Convex always-on deployment](docs/convex-always-on.md). The retained Azure workflow below is optional and does not power the current production app.

`./infra/deploy.sh` (safe to re-run; details in `infra/README.md`):
- Resource group `call4me-rg` in `northcentralus` (Azure for Students allows only a few regions; the script checks).
- Container Apps (WebSockets, exactly 1 replica, no cold start), PostgreSQL Flexible Server (skipped when `STORAGE_BACKEND=convex`), Key Vault, Application Insights, ACR.
- Copies secrets from `.env` into Key Vault; generates `API_TOKEN` on first deploy.
- ACR Tasks are blocked on student subscriptions, so it falls back to a local `docker buildx` (amd64) build and push.
- `TELEPHONY=phone ./infra/deploy.sh` switches the deployed app to the backup demo.
- `az containerapp logs show` crashes (CLI bug); query `ContainerAppConsoleLogs_CL` in Log Analytics instead.

**Earlier Azure roadmap (not implemented):** shared call state (Redis) to scale past one replica, per-user sign-in instead of one shared token, Postgres on a private network, telephony we control end to end (Azure Communication Services) so the guard can check every line in real calls too, per-call cost tracking.

---

## 16. Latency budget (rep speaks → agent replies)

- Cartesia mode: handled inside Cartesia's agent; keep tool webhooks fast (`report_state` 5 s timeout, others 10 s, `ask_user` up to ~110 s).
- Phone mode: STT final ~300–500 ms · Claude turn: keep prompts lean · Guard <10 ms · TTS first audio as low as Cartesia allows (streamed). Greeting on human detection is pre-generated: target <1.5 s total.

---

## 17. Coding conventions

- Python: type hints everywhere, `async` for all I/O, small modules, `ruff` formatting.
- Each external service has a client module + mock twin; never call SDKs directly from business logic.
- Python state changes go through `engine/states.py`; Convex state changes use the recorder in `convex/managed.ts`.
- Redact before logging: Python uses `audit/log.py`; Convex applies its current redaction before persistence (limitations in section 2).
- Python storage goes through `open_store()`; no raw SQL outside the SQL adapter. Convex uses its own queries and mutations.
- Prefer clear names over clever code. Comment the "why," not the "what."

---

## 18. Status

Done: Convex-hosted mobile app, call API and managed Cartesia tools without a laptop server; restored Jev menu choices and background state checks; encrypted temporary answers and live subscriptions. Automated managed-call tests cover the HTTP-to-TypeSafe path with an intercepted provider response, state transitions, stale-result handling and PIN delivery; they do not establish carrier audio behavior. Retained legacy functionality: fake support line, phone-mode pipeline (audio, STT, Jev engine, menu navigation, Claude agent, guard, TTS), takeover, phone-mode evals (11/11), Python SQL/Convex storage and Azure deployment tooling.

Shelved: native iOS app, Live Activities, APNs push (needs a paid Apple account). Stretch: web push.

Before demoing a Cartesia call, test one by calling your own cell. Keep a recorded backup video of a full call.

---

## 19. Demo (3 minutes)

1. Problem: Deaf users vs phone-only support (quote from someone we interviewed).
2. On a phone, start a call ("Remove the $40 late fee; no plan changes") → the Live screen shows menu progress, then hold with a timer.
3. A rep answers → the agent discloses it's an AI and starts.
4. Rep asks for the account PIN → the screen flashes → the user taps the input and types → the agent relays it. Check that the test PIN is redacted from captions and records.
5. Rep offers a paid upgrade → `check_offer` / guard says no → the agent declines.
6. Fee waived, reference number → summary "34 minutes saved."
7. Proof: Convex production call and audit records; label the 11/11 eval results as legacy phone-mode validation.

---

## 20. What changed from the original plan

| Original plan | As built | Why |
|---|---|---|
| Twilio Programmable Voice + Media Streams | Cartesia Managed Agents place real calls; `/phone` page is the backup | Cartesia's agent handles the phone line, listening, voice and keypad tones in one service |
| SwiftUI iPhone app, Live Activities, APNs | Mobile web app (`web/`) served at `/` | Free Apple ID: no push, 7-day installs, judges can't install it |
| PostgreSQL only | Convex hosts the production app and call backend; Python retains SQL/Convex storage options | Expanded PR #1's reactive storage into a backend that works without the developer's laptop |
| Silero VAD, YAMNet | Energy VAD + time-domain classifier behind the same interfaces | No onnxruntime/TensorFlow in the image |
| Claude via Foundry (maybe) | Anthropic API directly; Claude via Cartesia in cartesia mode | Foundry settings exist but aren't wired |
| Guard checks every line | True in phone mode; cartesia mode relies on instructions + `check_offer` | Cartesia's agent speaks for itself |

---

## 21. Multi-agent team setup

The repo was built by several Claude Code agents in parallel; see **TEAM.md** and `.claude/agents/`.

- Each specialist agent **owns specific directories** (table in TEAM.md). Only edit files you own.
- Shared interfaces live in `backend/contracts.py` (owned by `platform`). Don't change another area's interface: message its owner or the lead with the change you need.
- Before marking a task done: run `uv run pytest` for your area and commit with a clear message on your own branch.
