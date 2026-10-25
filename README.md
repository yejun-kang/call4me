# call4me

**Deaf people can't use phone-only customer service. Now they can, by typing.**

call4me is a mobile web app and a voice agent that makes a customer service call for
you, start to finish. It gets through the phone menu, waits on hold, talks to the rep,
and asks you only for what only you know (an order number, a PIN, a yes or no). You
follow the whole call as large live captions and can step in by typing at any time.

Built at Cal Hacks 13.0 for Deaf and hard-of-hearing adults. Full design: `CLAUDE.md`.

---

## Why we built it

For most people, "just call them" takes five minutes: reschedule a doctor's appointment,
dispute a late fee, cancel a gym membership. For Deaf and hard-of-hearing adults, a lot
of those calls are a wall. There's no chat option, and the phone menu, the hold music,
and the rep are all sound.

Relay services help, but they don't take the call off your hands. A relay operator sits
in the middle, and you still have to stay present through every menu option and every
minute of hold. We wanted what hearing people already have: hand the call off, glance at
it now and then, and step in only when you're needed.

AI calling assistants that report back **after** the call ends aren't enough either. If
the rep asks a question only you can answer, or offers something you'd never agree to,
you need to see it **while it's happening**. That idea is the core of call4me.

## What it does

- **It asks only for what only you know.** When the rep needs your PIN or a choice
  between two appointment times, your whole screen flashes and the phone vibrates. You
  type the answer, the agent relays it by voice or the requested keypad tones. The answer is
  encrypted briefly in Convex, removed as soon as the waiting tool receives it, and redacted
  from logs and captions.
- **It stays inside your limits.** If the rep offers something you didn't ask for, like a
  faster plan for $10 more a month, the agent checks it against your limits and politely
  declines.
- **It's honest.** It always says it's an AI assistant calling on your behalf, in your own
  wording. It never makes up facts about you. It won't relay a full SSN, card number, or
  password.
- **You're in control.** Type a message anytime and the agent says it to the rep word for
  word.
- **Nothing relies on sound.** Every alert is visual or a vibration. The screen stays
  awake, and the app reconnects on its own if your signal drops.

### Example call: getting a late fee removed

1. The user types: *"Get the $40 late fee removed. Don't change my plan or agree to
   anything that costs money."*
2. The agent presses through the billing menu and waits on hold while the banner counts
   the minutes.
3. A person answers. The agent says it's an AI assistant calling for the customer.
4. The rep asks for the account PIN. The screen flashes, the user types it, and it's
   spoken once and then redacted.
5. The rep offers to waive the fee *if* the user upgrades their plan. The agent checks it
   against the limits and declines.
6. The rep waives the fee as a one-time courtesy. The agent reads back the details and
   gets a reference number.
7. The user sees a summary: fee removed, plan unchanged, reference number, minutes saved.

## How it works

```
Phone browser: static web app on Convex .site ── REST + subscriptions ──▶ Convex
Judges view (/dashboard/)                                           ├─ HTTP actions: calls, tools, webhooks
                                                                    ├─ call state, audit, live captions
                                                                    ├─ encrypted short-lived answer mailbox
                                                                    ├─ Jev (TypeSafe): menu choices and state checks
                                                                    ▼
                                              Cartesia: managed voice agent and phone line
```

The production app, call API, Cartesia webhooks and live subscriptions run on Convex;
they do not need the developer's laptop or a temporary tunnel. The legacy FastAPI
phone-mode pipeline remains in this repository for local tests and backup demos.

### One real call, step by step

1. **You set up the call** in the web app: company, number, goal, limits, the info the
   agent may share, and the opening line it should say. The app sends this to
   `POST /calls`.
2. **Convex starts the existing Cartesia agent** with your goal, limits, and opening line
   passed as dynamic variables. The agent's instructions and voice remain in Cartesia.
3. **The agent dials the company** from a Cartesia phone number, presses through the
   menu, waits on hold, and talks to the rep. It starts by saying it's an AI calling for
   you. It asks Jev for menu choices through `call4me_menu_choice`, then sends the
   returned key with Cartesia's built-in `send_dtmf` tool.
4. **Every utterance comes back as captions.** Cartesia sends each line to our webhook;
   Convex applies caption redaction, saves it, and streams it to your phone with a
   subscription. Before a person answers, a background Jev check classifies recent
   company speech as a menu, recording, hold, or person.
5. **The agent uses five tools on our backend:**
   - `menu_choice`: asks Jev which menu option fits the goal and returns the key or word
   - `ask_user`: puts a question on your screen and waits for your typed answer;
     explicit keypad requests use DTMF instead of reading the answer aloud
   - `check_offer`: tests any fee, offer, or plan change against your limits
   - `report_state`: tells the app whether the call is in a menu, on hold, or with a person
   - `finish`: records the outcome and reference number
6. **The call ends.** You get a summary, and Convex deletes the call data at
   Cartesia.

The current production app is [nautical-wolverine-162.convex.site](https://nautical-wolverine-162.convex.site/).
See [Convex always-on deployment](docs/convex-always-on.md) for setup and verification.

### Two ways to place a call

Production uses managed Cartesia calls. The legacy Python worker selects its mode
with `TELEPHONY`:

| Mode | What dials | Who is the rep | Use it for |
|---|---|---|---|
| `cartesia` (production) | A Cartesia agent calls the real number from a Cartesia phone number. Convex gets every utterance by webhook and answers the agent's tool calls. | A real company, or your own cell for testing | Real calls |
| `phone` (local legacy) | Our own pipeline: Cartesia speech-to-text and voice, Jev, Claude, guard | Whoever opens `/phone` in a browser; it plays the fake company's menu and hold music first | Backup demo, no phone network |

With `USE_MOCKS=true` every service is mocked and calls go to an in-process fake line.

### Tech stack

- **Cartesia: the voice and the phone line.** A Cartesia Managed Agent places real calls
  and presses menu keys. Our backup pipeline uses Cartesia streaming speech-to-text
  (`ink-whisper`) and Sonic 2 for the agent's voice.
- **Claude: the conversation.** Claude Haiku 4.5 runs inside the Cartesia agent, chosen
  for speed on a live call. In our own pipeline, Claude Sonnet 5.5 runs a tool-use loop
  (`say`, `ask_user`, `press_digits`, `end_call`, `request_takeover`) and writes the
  opening disclosure and the post-call summary.
- **Guard layer: limits in code.** In our own pipeline, every sentence passes
  `backend/agent/guard.py` before it's spoken. It runs in under 10 ms.
- **Jev (TypeSafe): menu choices and call-state decisions.** In production, Convex
  asks Jev which menu option matches the goal and classifies recent company captions
  in the background until a person answers. Cartesia sends the selected keypad tones.
  The legacy phone pipeline also uses Jev with transcript and audio-label context.
  Production reads `TYPESAFE_API_KEY` from Convex; a two-second timeout or provider
  error uses keyword heuristics, recorded as `source: "heuristic"` rather than
  `source: "jev"` in the decision events and audit log.
- **Convex: the always-on backend.** HTTP actions serve the static app, start calls,
  receive Cartesia callbacks and tool calls, and hold encrypted answers briefly. Call
  records, audit events and redacted captions stream through Convex subscriptions.
- **Web app.** Next.js and Tailwind, built as a static export and served by Convex.
  It can be added to the home screen.

## Safety rules

These are the rules from CLAUDE.md section 2:

1. The agent always says it's an AI calling on your behalf.
2. Your answer is relayed by voice or requested keypad tones, then redacted everywhere.
3. It never makes up facts about you.
4. It never relays a full SSN, card number, or password.
5. It can't agree to anything outside your goal and limits.
6. You can step in at any time.
7. Every decision goes into an append-only audit log.

**How strictly they hold depends on the mode.** In `phone` mode the guard checks every
line before it is spoken. In `cartesia` mode Cartesia's agent speaks for itself: the
disclosure, the limits, and the no-SSN rule are in its instructions, and offers go
through our `check_offer` tool. Our side redacts everything before it is logged, stored,
or shown, and deletes the call data at Cartesia once the call is wrapped up. The guard
still can't block a sentence before Cartesia's agent says it. Closing that gap is our top
next step.

## Evals

```bash
USE_MOCKS=false uv run python -m evals.run --driver product --guard real
```

11 scripted scenarios on the fake line: cancellation, fee waiver, order status, callback
offer, transfer back to hold, menu loop, rep asks for a PIN, paid upgrade offer, rep
refuses to talk to an AI, user takeover, rep asks for an SSN. The scored driver is our own
pipeline (phone mode) with real Claude and Jev and the real guard:
`evals/results/product-claude.json` passed **11/11**, with 0 safety violations.
`product-mock-llm.json` used the mock LLM.

## Run it locally

```bash
uv sync
TELEPHONY=mock uv run pytest -q                       # unit + integration + full-call tests
TELEPHONY=mock USE_MOCKS=true uv run python -m evals.live_call # one full call on mocks
docker compose up -d                                   # local Postgres
(cd web && npm ci && npm run build)                    # the web app -> web/out, served at /
TELEPHONY=mock USE_MOCKS=true uv run uvicorn backend.main:app --reload
open http://localhost:8000/                            # web app; /dashboard/ = judges view
```

Set `TELEPHONY=mock` explicitly for mock runs: a `TELEPHONY=cartesia` value in `.env`
otherwise takes precedence over `USE_MOCKS` when selecting the call path.

For web app development with hot reload: `cd web && NEXT_PUBLIC_API_BASE=http://localhost:8000 npm run dev`
(see `web/README.md`).

Real services: copy `.env.example` to `.env` and fill in the keys.

- **Phone mode:** `TELEPHONY=phone uv run uvicorn backend.main:app --host 0.0.0.0 --port 8000`.
  Open `http://localhost:8000/phone` (the rep; tap **Get ready**) and the web app (the
  user). `uv run python -m evals.phone_rep` plays a scripted rep instead.
- **Cartesia mode** needs a public https URL for Cartesia's webhooks: run
  `cloudflared tunnel --url http://localhost:8000` and set `PUBLIC_BASE_URL` to it. On
  start the server creates or updates the Cartesia agent, tools, webhook, and phone number
  (`uv run python -m backend.cartesia.setup` does it by hand and prints them).

### Convex storage

Convex can replace PostgreSQL for call records, questions, audit logs, devices, saved
menus, and reactive live captions. Python remains the single call worker; private answers
are delivered in memory only. SQL stays the default until `STORAGE_BACKEND=convex` is
selected. See [setup, tests, SQL data copy, and teammate handoff](docs/convex-migration.md).
Each teammate can connect their own Convex deployment without changing source.

## Deploy to Azure

```bash
az login                      # the subscription with the credits
./infra/deploy.sh             # resource group call4me-rg in northcentralus
```

This creates Container Apps, PostgreSQL, Key Vault, Application Insights, and a container
registry. It copies the secrets from `.env` into Key Vault, then builds the image (web app
included) and rolls it out. It prints the web app URL.
Azure for Students only allows a few regions, and the script checks for that. Details and
troubleshooting: `infra/README.md`.

On Azure every API call needs the access token (`API_TOKEN`, generated by `deploy.sh`).
`POST /calls` dials real numbers, so the API is never open. The web app asks for the
token once. To print it:
`az keyvault secret show --vault-name <vault> --name api-token --query value -o tsv`.

## Using the web app on your phone

Open the Azure URL on your phone. iPhone: Safari > Share > **Add to Home Screen**. Android:
Chrome > menu > **Install app**. Enter the access code once. During a call:

- Captions are large, and the banner shows where the call is (menu, hold with a timer, a
  person, needs your answer).
- When the agent needs something only you know, the whole screen flashes and the phone
  vibrates where supported. Tap the answer field to open the keyboard. The question,
  input, and **Send answer** button fit above it; long questions can be scrolled.
- Type a message at any time and the agent says it to the rep. In phone mode, **Take
  over** stops the agent and speaks your words directly; hand back with one tap. In
  Cartesia mode, your message is said word for word on the agent's next turn.
- The screen stays awake (Wake Lock), and the app reconnects by itself if the network drops.

Keep the app open during a call. The judges view is at `/dashboard/`. The native iOS app
in `ios/` is shelved.

## What's where

| Path | What |
|---|---|
| `backend/main.py` | REST + WebSocket API (`/calls`, `/requests/{id}/answer`, `/devices`, `/metrics`, ...) |
| `backend/auth.py` | Access token check on every route (when `API_TOKEN` is set) |
| `backend/cartesia/` | Cartesia mode: agent setup, webhook + tools, one call (`call.py`) |
| `backend/calls.py` | Phone/mock mode: telephony → audio → STT → engine → Claude → guard → TTS |
| `backend/engine/` | Call states, Jev checks, menu navigation, human detection |
| `backend/agent/` | Claude tool-use loop, `ask_user`, guard layer |
| `backend/telephony/`, `fakeline/` | Phone-mode line (`/phone` page) and mock line; the fake company's menu and hold audio |
| `backend/audio/`, `backend/speech/` | VAD, music classifier; Cartesia STT/TTS |
| `backend/config.py`, `backend/telemetry.py` | Settings from env or Key Vault; Application Insights (redacted) |
| `web/` | Mobile web app (Next.js + Tailwind, static export served at `/`; judges view at `/dashboard/`) |
| `dashboard/` | Backup console (`/console/`) and the phone-mode rep page (`/phone`) |
| `evals/` | Scenarios, simulator, scoring, product driver |
| `ios/` | Shelved native iOS app (replaced by `web/`) |
| `infra/` | Azure Bicep + `deploy.sh` |

## Challenges and what we learned

- **Safety when someone else's agent is speaking.** With a hosted agent we can't block a
  sentence before it goes out, so we moved the rules into its instructions, routed every
  offer through `check_offer`, and redact everything on our side.
- **Takeover with a hosted agent.** A hosted agent can't be muted from outside, so typed
  messages are queued and said word for word on its next turn.
- **Phone menus that sound like voicemail.** Automatic voicemail detection hung up on long
  recorded menus. We turned it off and let the agent report what it hears.
- **Native app vs. web app.** Lock-screen alerts in our SwiftUI app needed a paid Apple
  developer account, so we rebuilt the client as a mobile web app.
- **Latency is a design problem.** A rep hangs up if the line goes quiet. Every reply in
  our pipeline costs

  $$t_{\text{reply}} = t_{\text{speech-to-text}} + t_{\text{Claude}} + t_{\text{guard}} + t_{\text{voice}},$$

  so we kept the guard under 10 ms, pre-generated the greeting, and taught the agent to say
  short holding lines while the user types.
- **Accessibility changes every default.** Alerts can't be sounds, captions have to be
  big, and the interface text has to be plain, since English is a second language for
  many ASL users.
- **Building in parallel.** We split the backend across several Claude Code agents in
  separate git worktrees (see `TEAM.md`). The shared interfaces had to come first, or
  every merge broke.

## What's next

- Test with Deaf and hard-of-hearing users and redesign the screens around what they tell us.
- Hard limits on real calls: check the agent's speech before it reaches the line, so the
  guard works the same in every mode.
- Instant takeover: bridge the user's typed words straight into the call with no wait.
- Saved menu routes, so the second call to the same company skips to the right department.
- Push notifications, so the user can put their phone down during a long hold.
- Sign language input, so users can answer in ASL instead of typing.

## Team

Yejun Kang and ChoiCube84, at Cal Hacks 13.0.
