# Hackathon log

- **Project:** call4me
- **Event:** Cal Hacks 13.0
- **What it does:** A mobile web app and Cartesia voice agent that makes a customer service call for Deaf and hard-of-hearing users, who follow it as live captions and answer by typing.
- **Live app:** https://nautical-wolverine-162.convex.site/
- **Repo:** https://github.com/yejun-kang/call4me
- **Frontend:** Convex static hosting
- **Convex deployment:** https://nautical-wolverine-162.convex.cloud
- **Components:** none
- **Convex features:** schema, indexes, queries, mutations, actions, HTTP actions, crons, scheduled functions, file storage, realtime subscriptions (`ConvexClient.onUpdate`)
- **Auth:** Other (shared access-code and worker tokens checked in `convex/lib/auth.ts` and `convex/phone.ts`)
- **AI models:** `claude-haiku-4.5`, `claude-sonnet-5-5`, `jev-latest`, `ink-whisper`, `sonic-2`
- **Started:** 2026-10-24T02:28:02Z
- **Last updated:** 2026-10-25T15:12:39Z

## How we use Convex

- **Placing a call:** the app's call API and Cartesia's webhook and five agent tools are HTTP actions (`convex/http.ts`, `convex/phone.ts`).
- **Live captions:** each caption is written by a mutation and pushed to the phone through a realtime subscription to `live.recent` (`convex/live.ts`, `web/lib/convex-live.ts`). The live call screen (`/live`) and the judges' dashboard (`/dashboard`) update without a refresh.
- **Jev menu and state decisions:** a scheduled function classifies company speech in the background, and decisions are stored as call events (`convex/jevWatch.ts`, `convex/jev.ts`, `convex/managed.ts`).
- **Private answers:** PINs are stored encrypted, read once, and removed by crons that also expire old captions, poll active calls, and delete finished call data at Cartesia (`convex/crons.ts`, `convex/managed.ts`, `convex/maintenance.ts`).
- **Hosting the app:** the Next.js export is uploaded with an action and served from file storage (`convex/site.ts`, `convex/http.ts`).
- **Call records and audit log:** tables with indexes (`convex/schema.ts`, `convex/storage.ts`).

## Log

- 2026-10-24 `5900409` Scaffold, shared contracts, DB models, audit log (`backend/contracts.py`, `backend/main.py`)
- 2026-10-24 `daf77ae` Guard layer for disclosure, privacy, limits (`backend/agent/guard.py`)
- 2026-10-24 `84ea308` Eval harness with 11 fake-line scenarios (`evals/`)
- 2026-10-24 `a6e8b59` Demo dashboard (`dashboard/`)
- 2026-10-24 `1679dcf` Live call pipeline and API (`backend/calls.py`)
- 2026-10-24 `394aab7` Real calls via Cartesia, mobile web app (`backend/cartesia/call.py`, `web/`)
- 2026-10-24 `9e2e23a` Convex storage and live caption subscriptions (`convex/schema.ts`, `convex/live.ts`, `convex/storage.ts`, `web/lib/convex-live.ts`)
- 2026-10-25 `eb136e0` Jev state checks and menu choices on Cartesia calls (`backend/cartesia/`)
- 2026-10-25 `b19be06` Keypad answers sent as DTMF (`backend/cartesia/call.py`)
- 2026-10-25 `b023901` Haiku 4.5 voice flow (`backend/cartesia/spec.py`)
- 2026-10-25 `9a01227` App and managed calls run on Convex (`convex/phone.ts`, `convex/managed.ts`, `convex/http.ts`, `convex/site.ts`)
- 2026-10-25 `c2e2ed0` Clean app routes from Convex static export (`convex/http.ts`)
- 2026-10-25 `f2161fa` Shorter encrypted answer retention (`convex/managed.ts`)
- 2026-10-25 `57d1d19` Jev decisions in Convex managed calls (`convex/jev.ts`, `convex/jevWatch.ts`)
- 2026-10-25 `33f8b9b` Submission README (`README.md`, `docs/images/`)
