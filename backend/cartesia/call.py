"""One call placed and run by a Cartesia Managed Agent (TELEPHONY=cartesia).

Cartesia dials the company from our Cartesia number and runs the conversation
(listening, Claude, speaking, keypad tones). We stay in the loop through:

- the call webhook: every utterance (`call_turn`) becomes a live caption, and
  `call_completed` / `call_failed` wrap the call up;
- webhook tools the agent calls: ask the user (they type), check an offer against
  the user's limits, pick a menu option, report where the call is, record the outcome;
- Jev: every company utterance is classified (menu, hold, person, ...) to drive the
  call state, and Jev picks the menu key when the agent asks (`menu_choice`). The
  agent (Claude Haiku on Cartesia) does the talking; Jev makes the fast typed calls.

Same surface as `calls.LiveCall` (takeover, handback, type_text, cancel, ...), so
the API endpoints and dashboard don't care which one runs a call.

Privacy: answers and pre-call info are registered for redaction before anything
is logged or shown; our DB and live channel only ever see redacted text. Cartesia
does see them (its agent has to relay them), and keeps call data until we delete it:
we delete it as soon as the call is wrapped up.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
from collections import deque
from typing import Any

from backend.agent.guard import looks_high_sensitivity
from backend.agent.ports import (
    BrokerAnswerSource,
    DbAuditSink,
    DbRequestStore,
    MemoryRequestStore,
    NotifierUserChannel,
    RequestStore,
)
from backend.audit import log as audit
from backend.cartesia import setup as cartesia_setup
from backend.cartesia.api import CartesiaAgentsApi
from backend.cartesia.spec import ASK_USER_WAIT_S
from backend.contracts import (
    CallEvent,
    CallSession,
    CallState,
    DecisionClient,
    JevDecision,
    LiveMessage,
    Sensitivity,
    UserRequest,
    UserRequestStatus,
    utcnow,
)
from backend.engine import jev_checks, menu
from backend.engine import states as st
from backend.notify.live import hub

log = logging.getLogger("call4me.cartesia.call")

S = CallState
PRE_PERSON = frozenset({S.DIALING, S.MENU, S.HOLD, S.RECORDED_MESSAGE, S.CALLBACK_OFFERED})
# Cartesia `end_reason` -> what the user reads.
END_REASONS = {
    "agent_hangup": "The assistant ended the call.",
    "client_hangup": "The company ended the call.",
    "api_cancelled": "You cancelled the call.",
    "voicemail_detected": "The call reached voicemail.",
    "call_inactivity": "The call ended after a long silence.",
    "client_inactivity": "The call ended after a long silence.",
    "max_duration": "The call reached its time limit.",
    "dial_no_answer": "No one answered.",
    "dial_busy": "The line was busy.",
    "dial_failed": "The call could not be placed.",
    "dial_timeout": "No one answered.",
}
STATUS_POLL_S = 15.0  # backup to the webhook: notice a finished call even if events are lost

# Jev state labels we act on. Voicemail and call_ended are left to Cartesia, which ends
# the call itself (the webhook wraps up); silence changes nothing.
JEV_TO_STATE = {
    "menu": S.MENU,
    "recorded_message": S.RECORDED_MESSAGE,
    "hold_music": S.HOLD,
    "callback_offer": S.CALLBACK_OFFERED,
    "human": S.IN_CONVERSATION,
}
# What the agent's report_state would say for each Jev label, to spot disagreements.
JEV_TO_REPORT = {
    "menu": "menu",
    "recorded_message": "hold",
    "hold_music": "hold",
    "callback_offer": "hold",
    "human": "person",
}
JEV_STATE_THRESHOLD = 0.6  # same bar as the phone-mode engine
# Higher than the engine's: there is no greeting/response check here, and a false
# "person" stops the watch until the agent reports hold again.
JEV_HUMAN_THRESHOLD = 0.75
JEV_MENU_SURE = 0.5  # below this the agent is told Jev is unsure
JEV_TIMEOUT_S = 2.0  # then keyword heuristics answer (jev_checks fallback)
REMOTE_WINDOW = 4  # recent company utterances Jev sees

_MENU_LINE = re.compile(r"^\s*(?:press\s+)?([^:]+?)\s*:\s*(.+?)\s*$", re.IGNORECASE)
_DIGITS = re.compile(r"^[0-9*#]+$")

by_call_id: dict[str, CartesiaCall] = {}


def _decision_client(settings: Any) -> DecisionClient:
    """Jev with a key; keyword heuristics without one or with mocks (like phone mode)."""
    key = getattr(settings, "typesafe_api_key", "") or ""
    if getattr(settings, "use_mocks", False) or not key:
        return jev_checks.MockDecisionClient()
    return jev_checks.JevDecisionClient(api_key=key)


def _agent_menu(text: str) -> dict[str, str]:
    """The agent's 'key: label' lines -> action key -> label. Non-digit keys are words
    to say ("representative: talk to someone")."""
    options: dict[str, str] = {}
    # Models sometimes return comma-separated key/label pairs despite the line
    # format. Split only before another key, preserving commas inside labels.
    for line in re.split(
        r"[\n;]|,\s*(?=(?:press\s+)?(?:[0-9*#]+|(?:say\s+)?[a-z][a-z'-]*)\s*:)",
        text,
        flags=re.IGNORECASE,
    ):
        m = _MENU_LINE.match(line)
        if not m:
            continue
        key, label = m.group(1).strip().lower(), m.group(2).strip()
        if not _DIGITS.match(key):
            key = menu.SAY_PREFIX + key.removeprefix("say").strip()
        options.setdefault(key, label)
    return options


def _limits_text(session: CallSession) -> str:
    lim = session.limits
    parts = [
        "Plan or subscription changes allowed."
        if lim.allow_plan_changes
        else "No plan or subscription changes.",
        "Cancellation allowed." if lim.allow_cancellation else "No cancellations.",
        f"Spend at most ${lim.max_spend_usd:g}." if lim.max_spend_usd else "No new charges.",
    ]
    if lim.notes:
        parts.append(lim.notes)
    return " ".join(parts)


class CartesiaCall:
    relays_messages = True  # typed text goes to the agent, which says it (no takeover)

    def __init__(
        self,
        session: CallSession,
        *,
        settings: Any,
        known_info: dict[str, str] | None = None,
        api: CartesiaAgentsApi | None = None,
        decisions: DecisionClient | None = None,
        persist: bool = True,
    ) -> None:
        self.session = session
        self.id = session.id
        self.settings = settings
        self.persist = persist
        self.known_info = dict(known_info or {})
        for value in self.known_info.values():
            audit.register_secret(session.id, value)
        self.api = api or CartesiaAgentsApi(settings.cartesia_api_key)
        self.call_id: str | None = None
        self.recorder: st.TransitionRecorder = st.DbRecorder() if persist else st.MemoryRecorder()
        self.requests: RequestStore = DbRequestStore() if persist else MemoryRequestStore()
        self.audit_sink = DbAuditSink()
        self.user = NotifierUserChannel()
        self.answers = BrokerAnswerSource()
        self.transcript: list[str] = []
        self.outcome: str | None = None
        self.reference: str | None = None
        self._messages: list[str] = []  # typed by the user, for the agent to say
        self.decisions = decisions or _decision_client(settings)
        self._remote: deque[str] = deque(maxlen=REMOTE_WINDOW)  # redacted company speech
        self._jev_lock = asyncio.Lock()  # FIFO: checks apply in the order speech arrived
        self._jev_count = 0
        self._jev_last: JevDecision | None = None
        self._tasks: set[asyncio.Task[Any]] = set()
        self._finished = asyncio.Event()
        self._finishing = False

    # ------------------------------------------------------------- lifecycle

    async def start(self) -> None:
        try:
            setup = cartesia_setup.current() or await cartesia_setup.ensure(self.settings)
            self.call_id = await self.api.start_call(
                agent_id=setup.agent_id,
                from_number_id=setup.from_number_id,
                to_number=self.session.phone_number,
                dynamic_variables=self._variables(),
            )
        except Exception as e:  # noqa: BLE001 - a failed dial ends this call, not the server
            log.exception("could not start Cartesia call for %s", self.id)
            await self._fail(_dial_failure(e))
            return
        by_call_id[self.call_id] = self
        await self._audit("call.dial", f"Cartesia call {self.call_id} placed")
        self._spawn(self._poll_status())

    def _variables(self) -> dict[str, str | int | float | bool]:
        known = "; ".join(f"{k}: {v}" for k, v in self.known_info.items()) or "none"
        return {
            "session_id": self.id,
            "company": self.session.company,
            "goal": self.session.goal,
            "limits": _limits_text(self.session),
            "known_info": known,
            "disclosure": self.session.disclosure_text,
        }

    async def _poll_status(self) -> None:
        while not self._finished.is_set():
            await asyncio.sleep(STATUS_POLL_S)
            if self.call_id is None or self._finishing:
                return
            with contextlib.suppress(Exception):
                call = await self.api.get_call(self.call_id)
                if call.get("status") in ("completed", "failed"):
                    await self.finish(call)

    # ------------------------------------------------------------- call webhook

    async def on_event(self, event: dict[str, Any]) -> None:
        kind = event.get("type")
        if kind == "call_turn":
            await self._on_turn(event.get("turn") or {})
        elif kind == "call_started":
            await self._audit("call.connected", "the company picked up")
        elif kind in ("call_completed", "call_failed"):
            await self.finish(event.get("call") or {})

    async def _on_turn(self, turn: dict[str, Any]) -> None:
        for tc in turn.get("tool_calls") or []:
            if tc.get("name") == "send_dtmf":
                args = tc.get("arguments") or {}
                digits = str(args.get("digits") or args.get("tones") or args)
                await self._event("menu_action", {"action": "dtmf", "value": audit.redact(digits)})
        text = audit.redact(str(turn.get("text") or "").strip())
        if not text:
            return
        speaker = "agent" if turn.get("role") == "assistant" else "remote"
        hub.publish(
            LiveMessage(
                type="caption",
                session_id=self.id,
                data={"speaker": speaker, "text": text, "final": True},
            )
        )
        self.transcript.append(f"{speaker}: {text}")
        if self.persist:
            await self._event("caption", {"speaker": speaker, "text": text}, audit_action=None)
        if speaker == "remote":
            self._remote.append(text)
            # Off the webhook's path: Cartesia shouldn't wait on Jev.
            self._spawn(self._jev_watch(text))

    # ------------------------------------------------------------- Jev

    async def _jev_watch(self, latest: str) -> None:
        """Classify the company's latest speech and move the call state on a confident
        answer. Only before a person answers; after that the agent's reports lead."""
        async with self._jev_lock:
            if self._finishing or self.session.state not in PRE_PERSON:
                return
            d = await jev_checks.classify_state(
                self.decisions,
                transcript=" ".join(self._remote),
                latest=latest,
                audio_label=None,
                current_state=self.session.state,
                timeout_s=JEV_TIMEOUT_S,
            )
            self._jev_last = d
            await self._record_jev(d, "new company speech")
            target = JEV_TO_STATE.get(d.choice)
            bar = JEV_HUMAN_THRESHOLD if target is S.IN_CONVERSATION else JEV_STATE_THRESHOLD
            if (
                target is None
                or d.probability < bar
                or target is self.session.state
                or self._finishing
                or self.session.state not in PRE_PERSON
            ):
                return
            await self._go(target, f"jev: {d.choice}", actor="jev", confidence=d.probability)

    async def _record_jev(self, d: JevDecision, reason: str) -> None:
        # Same shape as the phone-mode engine's, so the judges view shows both alike.
        self._jev_count += 1
        await self._event(
            "jev_decision",
            {
                "question": d.question,
                "choice": d.choice,
                "probability": round(d.probability, 3),
                "count": self._jev_count,
                "state": self.session.state.value,
                "reason": reason,
                "fallback": "fallback" in d.alternatives,
            },
            confidence=d.probability,
            audit_action="jev.decision",
        )

    # ------------------------------------------------------------- tools

    async def tool(self, name: str, args: dict[str, Any]) -> str:
        handler = {
            "ask_user": self._ask_user,
            "check_offer": self._check_offer,
            "menu_choice": self._menu_choice,
            "report_state": self._report_state,
            "finish": self._finish_tool,
        }.get(name)
        if handler is None:
            return f"unknown tool {name}"
        result = await handler(args)
        return result + self._pending_messages()

    def _pending_messages(self) -> str:
        if not self._messages:
            return ""
        lines = " ".join(f'"{m}"' for m in self._messages)
        self._messages.clear()
        return f"\nMessage from the customer for the rep. Say it now, word for word: {lines}"

    async def _ask_user(self, args: dict[str, Any]) -> str:
        question = str(args.get("question") or "").strip() or "The rep needs information."
        keypad = args.get("delivery") == "dtmf"
        resume_state = self.session.state if keypad else S.IN_CONVERSATION

        async def resume(reason: str) -> None:
            # A keypad prompt is not evidence that a person answered. Leave menu/hold
            # states alone, and don't overwrite a newer state reported while waiting.
            if not keypad or self.session.state is S.WAITING_ON_USER:
                await self._go(resume_state, reason)

        try:
            sensitivity = Sensitivity(str(args.get("sensitivity") or "medium"))
        except ValueError:
            sensitivity = Sensitivity.MEDIUM
        if sensitivity is Sensitivity.HIGH:
            await self._deny("ask_user", "high-sensitivity info is never relayed by the agent")
            await self.user.alert(
                self.session.user_id,
                "The rep asked for sensitive info",
                audit.redact(question),
                category="TAKEOVER",
                data={"session_id": self.id, "haptic": True},
            )
            if keypad:
                return "Not allowed: never relay a full card number, SSN, or password. Stay silent."
            return (
                "Not allowed: never relay a full card number, SSN, or password. Tell the rep "
                "the customer will provide it another way, and continue."
            )
        request = UserRequest(session_id=self.id, question=question, sensitivity=sensitivity)
        future = self.answers.expect(request.id)
        if not keypad or self.session.state not in PRE_PERSON:
            await self._go(S.WAITING_ON_USER, "ask_user: waiting for the user")
        try:
            await self.requests.create(request)
            await self._audit("user_request.created", "asked the user", subject=request.id)
            await self.user.ask(self.session.user_id, request)
            self.user.publish(
                LiveMessage(
                    type="ask_user",
                    session_id=self.id,
                    data={
                        "request_id": request.id,
                        "question": audit.redact(question),
                        "sensitivity": sensitivity.value,
                        "timeout_s": ASK_USER_WAIT_S,
                    },
                )
            )
            try:
                answer = await asyncio.wait_for(asyncio.shield(future), ASK_USER_WAIT_S)
            except TimeoutError:
                answer = None
        finally:
            self.answers.release(request.id)
        if answer is None:
            await self.requests.set_status(request.id, UserRequestStatus.TIMED_OUT)
            await resume("ask_user timed out")
            if keypad:
                return (
                    "No answer yet. Stay silent; do not send tones or guess. Call "
                    "call4me_ask_user again with delivery dtmf if the keypad answer "
                    "is still needed."
                )
            return (
                "No answer yet. Ask the rep to hold a little longer, then call "
                "call4me_ask_user again."
            )
        answer = answer.strip()
        audit.register_secret(self.id, answer)  # the endpoint did too; harmless twice
        digits = "".join(c for c in answer if not c.isspace() and c != "-") if keypad else ""
        if looks_high_sensitivity(answer, question) or (
            keypad and looks_high_sensitivity(digits, question)
        ):
            await self._deny("relay", "answer looks like a full card number or SSN")
            await resume("ask_user answer not relayed")
            if keypad:
                return "The answer is too sensitive to relay. Stay silent; do not send any tones."
            return (
                "The customer's answer is too sensitive to say. Tell the rep they will "
                "provide it another way."
            )
        if keypad:
            if not digits or any(c not in "0123456789*#" for c in digits):
                await resume("ask_user keypad answer invalid")
                return (
                    "Invalid keypad answer. Stay silent and do not send tones. Call "
                    "call4me_ask_user again with delivery dtmf to request only keypad digits."
                )
            audit.register_secret(self.id, digits)
        await self._audit("user_request.relayed", "answer handed to the agent", subject=request.id)
        await resume("ask_user answered")
        if keypad:
            return (
                f"The customer provided keypad digits: {digits}\n"
                "Call send_dtmf now with these exact digits. Preserve leading zeroes. "
                "Append # or * only if explicitly requested and not already included. "
                "Do not speak the digits or any commentary."
            )
        return f"The customer answered: {answer}\nTell the rep now. Read numbers digit by digit."

    async def _check_offer(self, args: dict[str, Any]) -> str:
        kind = str(args.get("kind") or "other")
        what = str(args.get("description") or kind)
        try:
            amount = float(args.get("amount_usd") or 0)
        except (TypeError, ValueError):
            amount = 0.0
        lim = self.session.limits
        allowed, why = True, ""
        if kind == "plan_change" and not lim.allow_plan_changes:
            allowed, why = False, "the customer did not allow plan or subscription changes"
        elif kind == "cancellation" and not lim.allow_cancellation:
            allowed, why = False, "the customer did not allow cancellations"
        if allowed and amount > (lim.max_spend_usd or 0):
            allowed, why = False, f"${amount:g} is over the customer's spending limit"
        if allowed:
            await self._audit("guard.check_offer", f"allowed: {audit.redact(what)}")
            if kind == "other":
                return "Allowed only if it is part of the goal. Otherwise politely decline."
            return "Allowed. Confirm the details with the rep."
        await self._deny(kind, f"{why} ({audit.redact(what)})")
        return f"Not allowed: {why}. Politely decline and steer back to the goal."

    async def _menu_choice(self, args: dict[str, Any]) -> str:
        heard = " ".join(self._remote)
        # The agent's list is structured; our own parse of the captions is the backup.
        options = _agent_menu(str(args.get("options") or "")) or menu.parse_menu_options(heard)
        if not options:
            return "Could not read the options. Pick the one that best fits the goal yourself."
        # Never accept a callback by pressing through it, unless that's all there is.
        options = menu.decline_callback_options(options) or options
        d = await jev_checks.choose_menu_option(
            self.decisions,
            goal=self.session.goal,
            menu_options=options,
            transcript=heard,
            timeout_s=JEV_TIMEOUT_S,
        )
        await self._record_jev(d, "menu: which option?")
        label = audit.redact(options.get(d.choice, ""))
        if d.choice.startswith(menu.SAY_PREFIX):
            word = d.choice.removeprefix(menu.SAY_PREFIX)
            action, shown = f'Say "{word}" to the menu', f'Say "{word}"'
        else:
            action, shown = f"Press {d.choice} with send_dtmf", f"Press {d.choice}"
        hub.publish(
            LiveMessage(
                type="summary",
                session_id=self.id,
                data={"text": f"Jev: {shown} ({label}), {round(d.probability * 100)}% sure"},
            )
        )
        if d.probability < JEV_MENU_SURE:
            return (
                f"{action} ({label}). Jev is not sure: if another option clearly fits the "
                "goal better, choose that one instead."
            )
        return f"{action} ({label})."

    async def _report_state(self, args: dict[str, Any]) -> str:
        reported = str(args.get("state") or "")
        target = {"menu": S.MENU, "hold": S.HOLD, "person": S.IN_CONVERSATION}.get(reported)
        last = self._jev_last
        if (
            target is not None
            and last is not None
            and last.probability >= JEV_STATE_THRESHOLD
            and JEV_TO_REPORT.get(last.choice, reported) != reported
        ):
            # The agent has heard everything (and knows what it pressed), so it still
            # moves the state; the timeline shows where Jev saw it differently.
            await self._event(
                "jev_disagreement",
                {"agent": reported, "jev": last.choice, "probability": round(last.probability, 3)},
            )
        note = audit.redact(str(args.get("note") or ""))[:200]
        if target is not None:
            await self._go(target, note or f"agent: {args.get('state')}")
        if note and target is S.MENU:
            # Why it chose that key: on the customer's screen ("What's happening"), not spoken.
            hub.publish(LiveMessage(type="summary", session_id=self.id, data={"text": note}))
        return "noted"

    async def _finish_tool(self, args: dict[str, Any]) -> str:
        self.outcome = audit.redact(str(args.get("summary") or "")).strip() or None
        ref = str(args.get("reference_number") or "").strip()
        self.reference = audit.redact(ref) if ref else None
        await self._audit("call.outcome", "agent recorded the outcome")
        return "Recorded. Say goodbye; end the call once the rep has said goodbye."

    # ------------------------------------------------------------- user controls

    async def takeover(self) -> bool:
        # A Cartesia agent can't be muted from outside; the user sends messages instead.
        return False

    async def handback(self) -> bool:
        return False

    async def type_text(self, text: str) -> None:
        """A message for the rep, said by the agent with its next tool call."""
        audit.register_secret(self.id, text.strip())  # may hold private details
        self._messages.append(text.strip())
        await self._event("user_message", {"chars": len(text)})

    async def continue_hold(self, keep_waiting: bool) -> None:
        if not keep_waiting:
            await self.cancel()

    async def cancel(self) -> None:
        if self.call_id is None:
            return
        try:
            await self.api.cancel_call(self.call_id)
        except Exception:  # noqa: BLE001 - it may already be over; the webhook wraps up
            log.exception("cancel failed for %s", self.id)

    # ------------------------------------------------------------- wrap-up

    async def finish(self, call: dict[str, Any]) -> None:
        if self._finishing:
            return
        self._finishing = True
        try:
            await self._wrap_up(call)
        except Exception:  # noqa: BLE001
            log.exception("wrap-up failed for %s", self.id)
        finally:
            await self._cleanup()

    async def _wrap_up(self, call: dict[str, Any]) -> None:
        from backend.calls import _read_back_reference

        s = self.session
        if not self.transcript and call.get("transcript"):
            for t in call["transcript"]:  # webhook turns lost: rebuild from the record
                text = audit.redact(str(t.get("text") or ""))
                if text and t.get("role") in ("user", "assistant"):
                    who = "agent" if t["role"] == "assistant" else "remote"
                    self.transcript.append(f"{who}: {text}")
        failed = call.get("status") == "failed" and not self.transcript
        reason = str(call.get("end_reason") or "")
        await self._go(S.FAILED if failed else S.ENDED, reason or "call ended")
        s.ended_at = utcnow()
        s.minutes_saved = round(max(0.0, (s.ended_at - s.started_at).total_seconds()) / 60, 1)
        s.outcome = self.outcome or END_REASONS.get(reason) or reason.replace("_", " ") or None
        s.reference_number = self.reference or _read_back_reference(self.transcript)
        summary = audit.redact(str(call.get("summary") or "")) or s.outcome or "The call ended."
        if self.persist:
            await self._save_session()
            # Kept for the summary screen (GET /calls/{id}); already redacted.
            await self._event(
                "call.ended",
                {"outcome": s.outcome, "minutes_saved": s.minutes_saved, "summary": summary},
            )
        data = {
            "summary": summary,
            "outcome": s.outcome,
            "reference_number": s.reference_number,
            "minutes_saved": s.minutes_saved,
            "state": s.state.value,
        }
        hub.publish(LiveMessage(type="summary", session_id=self.id, data={"text": summary, **data}))
        hub.publish(LiveMessage(type="ended", session_id=self.id, data=data))
        with contextlib.suppress(Exception):
            await self.user.alert(
                s.user_id,
                "Call done",
                summary,
                category="CALL_ENDED",
                data={"session_id": self.id, "haptic": True},
            )

    async def _cleanup(self) -> None:
        from backend import calls  # calls imports this module; import at use

        if self.call_id is not None:
            # Rule 8: don't leave the transcript and recording on Cartesia's side.
            with contextlib.suppress(Exception):
                await self.api.delete_call_data(self.call_id)
            by_call_id.pop(self.call_id, None)
        audit.forget_session(self.id)
        calls.registry.pop(self.id, None)
        self._finished.set()
        for task in list(self._tasks):
            if task is not asyncio.current_task():
                task.cancel()
        with contextlib.suppress(Exception):
            await self.api.aclose()
        if (close := getattr(self.decisions, "aclose", None)) is not None:
            with contextlib.suppress(Exception):
                await close()

    async def _fail(self, reason: str) -> None:
        with contextlib.suppress(st.IllegalTransition):
            await st.transition(
                self.session, S.FAILED, reason=reason, recorder=self.recorder, actor="system"
            )
        self.session.outcome = reason
        self.session.ended_at = utcnow()
        if self.persist:
            await self._save_session()
        data = {"summary": reason, "outcome": reason, "state": S.FAILED.value}
        hub.publish(LiveMessage(type="ended", session_id=self.id, data=data))
        await self._cleanup()

    async def _save_session(self) -> None:
        from backend.db.models import CallSessionRow
        from backend.db.store import open_store

        s = self.session
        try:
            async with open_store() as db:
                row = await db.get(CallSessionRow, s.id)
                if row is None:
                    return
                row.state = s.state
                row.ended_at = s.ended_at
                row.outcome = audit.redact(s.outcome) if s.outcome else None
                row.reference_number = s.reference_number
                row.minutes_saved = s.minutes_saved
                await audit.append(
                    db,
                    actor="system",
                    action="call.end",
                    subject=s.id,
                    reason=f"call finished in {s.state.value}",
                    diff={"outcome": row.outcome, "minutes_saved": s.minutes_saved},
                )
                await db.commit()
        except Exception:  # noqa: BLE001
            log.exception("could not save session %s", s.id)

    # ------------------------------------------------------------- helpers

    async def _go(
        self,
        target: CallState,
        reason: str,
        *,
        actor: str = "agent",
        confidence: float | None = None,
    ) -> None:
        """Walk to `target` through legal states (e.g. menu -> person passes through
        HUMAN_SUSPECTED and HUMAN_CONFIRMED, so the timeline reads like the engine's)."""
        path = [target]
        if target is S.IN_CONVERSATION and self.session.state in PRE_PERSON:
            path = [S.HUMAN_SUSPECTED, S.HUMAN_CONFIRMED, S.IN_CONVERSATION]
        elif target in (S.MENU, S.RECORDED_MESSAGE) and self.session.state in (
            S.IN_CONVERSATION,
            S.WAITING_ON_USER,
        ):
            path = [S.HOLD, target]
        for state in path:
            try:
                await st.transition(
                    self.session,
                    state,
                    reason=reason,
                    recorder=self.recorder,
                    actor=actor,
                    confidence=confidence,
                )
            except st.IllegalTransition:
                return

    async def _event(
        self,
        kind: str,
        detail: dict[str, Any],
        *,
        confidence: float | None = None,
        audit_action: str | None = None,
    ) -> None:
        try:
            await self.recorder.event(
                CallEvent(
                    session_id=self.id,
                    kind=kind,
                    from_state=self.session.state,
                    to_state=self.session.state,
                    confidence=confidence,
                    detail=detail,
                ),
                audit_action=audit_action,
            )
        except Exception:  # noqa: BLE001 - the timeline is best effort
            log.exception("could not record %s", kind)

    async def _audit(self, action: str, reason: str, *, subject: str | None = None) -> None:
        if not self.persist:
            return
        with contextlib.suppress(Exception):
            await self.audit_sink(
                actor="agent", action=action, subject=subject or self.id, reason=reason
            )

    async def _deny(self, action: str, reason: str) -> None:
        await self._event("guard_denied", {"action": action, "reason": reason})
        if self.persist:
            with contextlib.suppress(Exception):
                await self.audit_sink(
                    actor="guard",
                    action=f"guard.{action}",
                    subject=self.id,
                    allowed=False,
                    reason=reason,
                )

    def _spawn(self, coro: Any) -> asyncio.Task[Any]:
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task


def _dial_failure(e: BaseException) -> str:
    text = str(e).lower()
    if "402" in text or "credit" in text or "quota" in text:
        return "Cartesia is out of credits (or out of phone numbers). The call was not made."
    if "public_base_url" in text:
        return "The server's public URL isn't set (PUBLIC_BASE_URL). The call was not made."
    if "e.164" in text or "to_number" in text or "invalid" in text:
        return "That phone number doesn't look valid. Use a US number like +14155551234."
    return "The call could not be placed. Try again in a moment."
