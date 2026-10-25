# Convex always-on deployment

The production app is `https://nautical-wolverine-162.convex.site/`. Convex serves
the static web export and the call API from this origin. Cartesia calls its webhook
and five assigned tools on the same origin. Convex subscriptions use the matching
`https://nautical-wolverine-162.convex.cloud` URL. Neither a local Python process nor
a Cloudflare tunnel is in the production call path.

The `.convex.site` hostname belongs to the production deployment and remains the
same across code pushes. Removing that deployment would remove the address. A custom
branded domain is a separate choice; it is not required for a durable address.

## Deploying changes

1. Set the production Convex environment variables before placing any calls:
   `CALL4ME_VIEWER_TOKEN`, `CALL4ME_BACKEND_TOKEN`, `CALL4ME_TOOL_SECRET`,
   `CALL4ME_ANSWER_KEY` (64 hex characters), `CARTESIA_API_KEY`,
   `CARTESIA_AGENT_ID`, `CARTESIA_NUMBER_ID`, and `TYPESAFE_API_KEY`. Keep values out of Git and shell
   history. The tool secret must match Cartesia's existing webhook/tool secret.
   The deployed backend reads these values from Convex, not the laptop's `.env`.
   A missing or failing TypeSafe key causes explicitly labeled heuristic decisions,
   not real Jev calls.
2. Run `npm test`, `npm run typecheck`, then `npx convex deploy` from the repository
   root.
3. Restore the existing Cartesia agent's Jev integration **after** deploying the
   Convex endpoint. Review the dry run, then apply the same change:

   ```sh
   PYTHONPATH=. .venv/bin/python scripts/enable_cartesia_jev.py
   PYTHONPATH=. .venv/bin/python scripts/enable_cartesia_jev.py --apply
   ```

   This assigns `call4me_menu_choice` alongside the four existing webhook tools
   and restores the instruction to ask Jev for menu choices. It preserves the
   current voice, conversation model and PIN delivery configuration.
4. Build the static app from `web/` with
   `NEXT_PUBLIC_CONVEX_URL=https://nautical-wolverine-162.convex.cloud` and an empty
   `NEXT_PUBLIC_API_BASE`, using `npm run build`.
5. From the repository root, set
   `CONVEX_URL=https://nautical-wolverine-162.convex.cloud` and run
   `node scripts/upload_convex_site.mjs`. This updates the files in Convex storage.
6. If the Cartesia URLs need restoring after all five tools are assigned, run
   `PYTHONPATH=. .venv/bin/python scripts/switch_cartesia_to_convex.py`. It changes
   only the five assigned tool URLs and their webhook URL. It verifies that the
   agent configuration is identical before and after; it does not edit the voice,
   model, instructions or tool assignments.

Open `/health` and the app root on the production `.convex.site` URL, then confirm
`/calls` requires the access code. A real call is still needed to verify carrier
audio, menu tones and PIN tones after deployment.

To check the deployed TypeSafe connection independently of a telephone call, run
the privileged internal action:

```sh
npx convex run jevWatch:checkConnection '{}' --prod
```

It sends two synthetic examples to the real provider without creating a call or
writing database rows. `passed: true` requires `source: "jev"` for both decisions,
menu choice `"2"`, and state choice `"human"`. A heuristic fallback does not pass
this check. This verifies provider connectivity and decisions, not telephone audio.

## Jev in managed calls

The managed agent sends menu options to `call4me_menu_choice`. The Convex handler
in `convex/phone.ts` calls Jev through `convex/jev.ts`, using TypeSafe's Choice API
and the `jev-latest` model. Jev chooses an option from the supplied labels and
goal; the tool returns the selected key to Cartesia, whose native `send_dtmf`
tool sends the tones. A menu choice does not wait for a separate state decision
before returning its action.

Company speech arriving at `/cartesia/webhook` also schedules the background
watcher in `convex/jevWatch.ts` while the call is in a menu, on hold, or otherwise
before a person has answered. Jev receives the recent redacted company captions,
not a separate audio stream. The watcher retains the earlier confidence thresholds
(0.6 for automated states, 0.75 for a person), and late results cannot override a
newer state report. The agent's own `report_state` tool remains available.

TypeSafe requests have a two-second timeout and fall back to the earlier keyword
heuristics on errors. `jev_decision` events and `jev.decision` audit entries
record `source: "jev"` for provider responses or `source: "heuristic"` with a
`fallback_reason` for fallback decisions. Seeing the module installed or hearing
tones alone does not prove Jev was used: inspect the decision's source and the
subsequent `menu_action` event. The automated HTTP integration tests exercise this
path with an intercepted provider response; they do not verify carrier audio.

This restoration keeps the current Haiku 4.5 conversation model, voice, silent
keypad-answer instructions, and mobile PIN input behavior.

## Private answers

The app sends a PIN or other private answer to its same-origin HTTPS endpoint. An
HTTP action encrypts it with AES-GCM before writing to Convex. The waiting Cartesia
tool decrypts it, deletes the ciphertext from Convex, and returns the answer once.
An abandoned answer is marked to expire after 60 seconds; typed messages use 90
seconds. A cleanup job runs every 30 seconds and removes up to 100 expired rows
from each table per run. This targets short retention under normal operation, not
a strict two-minute deletion guarantee: delayed jobs or a backlog can extend it.
The answer polling query currently does not reject expired rows before cleanup.
Finishing a call also deletes its remaining answers and typed messages.

The answer endpoint does not put plaintext in ordinary call records or audit
payloads. Webhook captions and summaries use pattern-based redaction for email
addresses and numeric strings of four or more digits. Arbitrary private text,
shorter codes and digits transcribed as words are not guaranteed to be removed;
do not describe this as universal redaction. Cartesia necessarily receives the
answer to speak it or send its keypad tones. Deletion of its call data is attempted
on completion, with a five-minute retry job if that delete fails.

The mobile home-screen app installed from an old temporary tunnel has a different
origin. Open the production URL on the phone and add that page to the home screen
to use the always-on deployment. The access code remains the same.
