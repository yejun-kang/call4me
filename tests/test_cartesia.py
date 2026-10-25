"""Cartesia calls: setup, dialing, the event webhook, and our webhook tools.

A fake Cartesia API (httpx.MockTransport) stands in for api.cartesia.ai.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from backend import calls
from backend.cartesia import setup as cartesia_setup
from backend.cartesia import spec
from backend.cartesia.api import CartesiaAgentsApi
from backend.cartesia.call import CartesiaCall, _agent_menu, by_call_id
from backend.contracts import CallLimits, CallSession, CallState, UserRequestStatus
from backend.engine import jev_checks
from backend.engine.jev_checks import MockDecisionClient
from backend.notify.live import answers, hub

SETTINGS = SimpleNamespace(
    cartesia_api_key="sk_car_test",
    cartesia_voice_id="voice-1",
    cartesia_agent_model="claude-haiku-4.5",
    cartesia_webhook_secret="",
    public_base_url="https://call4me.example",
)
ORDER = "112-4567890-1234567"


class FakeCartesia:
    """Records requests; keeps agents/tools/webhooks/numbers in memory."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, str, Any]] = []
        self.agents: list[dict[str, Any]] = []
        self.tools: list[dict[str, Any]] = []
        self.webhooks: list[dict[str, Any]] = []
        self.numbers: list[dict[str, Any]] = []
        self.cancelled: list[str] = []
        self.deleted: list[str] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        path, method = request.url.path, request.method
        self.requests.append((method, path, body))
        assert request.headers["Cartesia-Version"] == "2026-08-14"
        assert request.headers["Authorization"] == "Bearer sk_car_test"
        if path == "/agents/webhooks":
            if method == "GET":
                return httpx.Response(200, json={"data": self.webhooks})
            hook = {"id": f"wh_{len(self.webhooks)}", **body}
            self.webhooks.append(hook)
            return httpx.Response(200, json=hook)
        if path.startswith("/agents/webhooks/"):
            return httpx.Response(200, json={"id": path.rsplit("/", 1)[1]})
        if path == "/v1/agents/tools":
            if method == "GET":
                return httpx.Response(200, json={"data": self.tools})
            tool = {"id": f"tool_{len(self.tools)}", **body}
            self.tools.append(tool)
            return httpx.Response(201, json=tool)
        if path.startswith("/v1/agents/tools/"):
            return httpx.Response(200, json={"id": path.rsplit("/", 1)[1]})
        if path == "/v1/agents":
            if method == "GET":
                return httpx.Response(200, json={"data": self.agents})
            agent = {"id": f"agent_{len(self.agents)}", **body}
            self.agents.append(agent)
            return httpx.Response(201, json=agent)
        if path.startswith("/v1/agents/"):
            return httpx.Response(200, json={"id": path.rsplit("/", 1)[1]})
        if path == "/agents/phone-numbers":
            return httpx.Response(200, json={"data": self.numbers})
        if path == "/agents/phone-numbers/provision":
            n = {"id": "pn_1", "number": "+14155550000", "label": body["label"]}
            self.numbers.append(n)
            return httpx.Response(201, json=n)
        if path == "/agents/calls" and method == "POST":
            return httpx.Response(200, json={"calls": [{"number": "x", "agent_call_id": "ac_1"}]})
        if path.endswith("/cancel"):
            self.cancelled.append(path.split("/")[3])
            return httpx.Response(200, json={"cancelled": True})
        if path.startswith("/agents/calls/") and method == "DELETE":
            self.deleted.append(path.rsplit("/", 1)[1])
            return httpx.Response(200, json={})
        if path.startswith("/agents/calls/"):
            return httpx.Response(200, json={"status": "started"})
        return httpx.Response(404, text=f"no route {method} {path}")

    def api(self) -> CartesiaAgentsApi:
        return CartesiaAgentsApi("sk_car_test", transport=httpx.MockTransport(self.handler))


@pytest.fixture
def fake() -> FakeCartesia:
    return FakeCartesia()


def session(**limits: Any) -> CallSession:
    return CallSession(
        user_id="u",
        company="Amazon Customer Service",
        phone_number="+14155551234",
        goal="Get a refund for headphones that arrived damaged.",
        limits=CallLimits(**limits),
        disclosure_text="Hi, I'm an AI assistant calling for my client.",
    )


async def started_call(
    fake: FakeCartesia, decisions: MockDecisionClient | None = None, **limits: Any
) -> CartesiaCall:
    await cartesia_setup.ensure(SETTINGS, fake.api())
    call = CartesiaCall(
        session(**limits),
        settings=SETTINGS,
        known_info={"Order number": ORDER},
        api=fake.api(),
        decisions=decisions,
        persist=False,
    )
    calls.registry[call.id] = call
    await call.start()
    return call


# --- setup ------------------------------------------------------------------------


async def test_setup_creates_everything_once_then_updates(fake: FakeCartesia) -> None:
    s = await cartesia_setup.ensure(SETTINGS, fake.api())
    assert s.agent_id == "agent_0" and s.from_number == "+14155550000"
    assert [t["name"] for t in fake.tools] == [
        "call4me_ask_user",
        "call4me_check_offer",
        "call4me_menu_choice",
        "call4me_report_state",
        "call4me_finish",
    ]
    tool = fake.tools[0]
    assert tool["api_schema"]["url"] == "https://call4me.example/cartesia/tools/ask_user"
    body = tool["api_schema"]["request_body_schema"]["properties"]
    assert body["session_id"] == {"type": "string", "dynamic_variable": "session_id"}
    assert fake.webhooks[0]["url"] == "https://call4me.example/cartesia/webhook"
    config = fake.agents[0]["config"]
    assert config["model"]["id"] == "claude-haiku-4.5"
    assert config["initial_message"] is None  # the company speaks first
    assert config["system_tools"]["send_dtmf"] == {"pre_tool_speech": "off"}
    assert config["system_tools"]["skip_turn"] == {
        "wait_timeout_secs": -1,
        "pre_tool_speech": "off",
    }
    assert body["delivery"]["enum"] == ["speech", "dtmf"]
    assert "delivery" not in tool["api_schema"]["request_body_schema"]["required"]

    n_requests = len(fake.requests)
    await cartesia_setup.ensure(SETTINGS, fake.api())  # idempotent: no new resources
    assert len(fake.agents) == 1 and len(fake.tools) == 5 and len(fake.numbers) == 1
    assert len(fake.requests) > n_requests


async def test_setup_needs_a_public_https_url(fake: FakeCartesia) -> None:
    bad = SimpleNamespace(**{**vars(SETTINGS), "public_base_url": ""})
    with pytest.raises(RuntimeError, match="PUBLIC_BASE_URL"):
        await cartesia_setup.ensure(bad, fake.api())


# --- dialing ------------------------------------------------------------------------


async def test_start_dials_with_call_facts_as_variables(fake: FakeCartesia) -> None:
    call = await started_call(fake)
    (_, _, body) = next(r for r in fake.requests if r[1] == "/agents/calls")
    assert body["agent_id"] == "agent_0" and body["from_number_id"] == "pn_1"
    (dest,) = body["outbound_calls"]
    assert dest["to_number"] == "+14155551234"
    v = dest["dynamic_variables"]
    assert v["session_id"] == call.id and v["company"] == "Amazon Customer Service"
    assert ORDER in v["known_info"] and "No new charges" in v["limits"]
    assert by_call_id["ac_1"] is call
    await call.finish({"status": "completed"})


# --- the event webhook ---------------------------------------------------------------


async def test_turns_become_redacted_captions(fake: FakeCartesia) -> None:
    call = await started_call(fake)
    q = hub.subscribe(call.id)
    await call.on_event(
        {"type": "call_turn", "call_id": "ac_1", "turn": {"role": "user", "text": "Order number?"}}
    )
    await call.on_event(
        {
            "type": "call_turn",
            "call_id": "ac_1",
            "turn": {"role": "assistant", "text": f"The order number is {ORDER}."},
        }
    )
    rep, agent = q.get_nowait(), q.get_nowait()
    assert rep.data == {"speaker": "remote", "text": "Order number?", "final": True}
    assert agent.data["speaker"] == "agent" and ORDER not in agent.data["text"]
    hub.unsubscribe(call.id, q)
    await call.finish({"status": "completed"})


async def test_completed_call_wraps_up_and_deletes_cartesia_copy(fake: FakeCartesia) -> None:
    call = await started_call(fake)
    await call.tool("finish", {"summary": "Refund of $49.99 issued.", "reference_number": "A7X291"})
    q = hub.subscribe(call.id)
    await call.on_event(
        {
            "type": "call_completed",
            "call_id": "ac_1",
            "call": {"status": "completed", "end_reason": "agent_hangup"},
        }
    )
    msgs = [q.get_nowait() for _ in range(q.qsize())]
    ended = next(m for m in msgs if m.type == "ended")
    assert ended.data["outcome"] == "Refund of $49.99 issued."
    assert ended.data["reference_number"] == "A7X291"
    assert call.session.state is CallState.ENDED
    assert fake.deleted == ["ac_1"]  # rule 8: nothing left on Cartesia's side
    assert call.id not in calls.registry and "ac_1" not in by_call_id
    hub.unsubscribe(call.id, q)


# --- webhook tools -------------------------------------------------------------------


async def test_ask_user_returns_the_typed_answer(fake: FakeCartesia) -> None:
    call = await started_call(fake)
    q = hub.subscribe(call.id)

    async def user_types() -> None:
        while True:
            msg = await q.get()
            if msg.type == "ask_user":
                answers.deliver(msg.data["request_id"], "98109")
                return

    typing = asyncio.create_task(user_types())
    reply = await call.tool(
        "ask_user", {"question": "ZIP code on the account?", "sensitivity": "low"}
    )
    await typing
    assert "The customer answered: 98109" in reply
    assert call.session.state is CallState.IN_CONVERSATION
    hub.unsubscribe(call.id, q)
    await call.finish({"status": "completed"})


async def test_ask_user_refuses_high_sensitivity(fake: FakeCartesia) -> None:
    call = await started_call(fake)
    reply = await call.tool("ask_user", {"question": "Full card number?", "sensitivity": "high"})
    assert reply.startswith("Not allowed")
    await call.finish({"status": "completed"})


async def answer_tool_request(
    call: CartesiaCall,
    args: dict[str, Any],
    answer: str,
    *,
    waiting_state: CallState,
) -> str:
    """Answer through the real broker after checking the UI's waiting state."""
    q = hub.subscribe(call.id)
    task = asyncio.create_task(call.tool("ask_user", args))
    try:
        while True:
            message = await asyncio.wait_for(q.get(), 1)
            if message.type == "ask_user":
                break
        assert call.session.state is waiting_state
        assert answers.deliver(message.data["request_id"], answer)
        return await asyncio.wait_for(task, 1)
    finally:
        hub.unsubscribe(call.id, q)
        if not task.done():
            task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


async def test_ask_user_dtmf_normalizes_keypad_input_and_redacts_it(fake: FakeCartesia) -> None:
    call = await started_call(fake)
    await call.tool("report_state", {"state": "menu"})
    q = hub.subscribe(call.id)
    typed = " 0 4-5\t6 * # "
    normalized = "0456*#"
    try:
        reply = await answer_tool_request(
            call,
            {"question": "Enter the account code, then star and pound.", "delivery": "dtmf"},
            typed,
            waiting_state=CallState.MENU,
        )
        assert "send_dtmf" in reply and normalized in reply
        assert "The customer answered:" not in reply
        assert "Read numbers digit by digit" not in reply
        assert call.session.state is CallState.MENU
        assert not any(
            r.to_state in (CallState.HUMAN_CONFIRMED, CallState.IN_CONVERSATION)
            for r in call.recorder.transitions
        )

        # Cartesia may echo either the typed spelling or its normalized tool argument.
        await call.on_event(
            {
                "type": "call_turn",
                "turn": {
                    "role": "assistant",
                    "text": f"Code {typed.strip()}; normalized {normalized}.",
                    "tool_calls": [{"name": "send_dtmf", "arguments": {"dtmf_tones": normalized}}],
                },
            }
        )
        messages = [q.get_nowait() for _ in range(q.qsize())]
        caption = next(m for m in messages if m.type == "caption")
        assert "[REDACTED]" in caption.data["text"]
        assert typed.strip() not in caption.data["text"]
        recorded = json.dumps(
            {
                "messages": [m.model_dump(mode="json") for m in messages],
                "events": [e.model_dump(mode="json") for e in call.recorder.events],
                "transcript": call.transcript,
            }
        )
        assert typed.strip() not in recorded and normalized not in recorded
        assert "0456" not in recorded
    finally:
        hub.unsubscribe(call.id, q)
        await call.finish({"status": "completed"})


@pytest.mark.parametrize(
    "prior_state",
    [
        CallState.DIALING,
        CallState.MENU,
        CallState.HOLD,
        CallState.RECORDED_MESSAGE,
        CallState.CALLBACK_OFFERED,
    ],
)
async def test_ask_user_dtmf_preserves_pre_person_state(
    fake: FakeCartesia, prior_state: CallState
) -> None:
    call = await started_call(fake)
    call.session.state = prior_state
    try:
        reply = await answer_tool_request(
            call,
            {"question": "Account code?", "delivery": "dtmf"},
            "0456",
            waiting_state=prior_state,
        )
        assert "send_dtmf" in reply and "0456" in reply
        assert call.session.state is prior_state
        assert not any(r.allowed for r in call.recorder.transitions)
    finally:
        await call.finish({"status": "completed"})


@pytest.mark.parametrize("delivery", [None, "speech", "dtmf"])
async def test_ask_user_during_human_conversation_waits_and_resumes(
    fake: FakeCartesia, delivery: str | None
) -> None:
    call = await started_call(fake)
    await call.tool("report_state", {"state": "person"})
    args = {"question": "ZIP code on the account?", "sensitivity": "low"}
    if delivery is not None:
        args["delivery"] = delivery
    try:
        reply = await answer_tool_request(
            call, args, "98109", waiting_state=CallState.WAITING_ON_USER
        )
        assert call.session.state is CallState.IN_CONVERSATION
        if delivery == "dtmf":
            assert "send_dtmf" in reply and "98109" in reply
            assert "The customer answered:" not in reply
        else:
            assert "The customer answered: 98109" in reply
            assert "Read numbers digit by digit" in reply
            assert "send_dtmf" not in reply
    finally:
        await call.finish({"status": "completed"})


@pytest.mark.parametrize("typed", ["PIN is 0456", "04/56", "0٤56", " -\t "])
async def test_ask_user_dtmf_rejects_non_keypad_answers_without_echo(
    fake: FakeCartesia, typed: str
) -> None:
    call = await started_call(fake)
    await call.tool("report_state", {"state": "menu"})
    try:
        reply = await answer_tool_request(
            call,
            {"question": "Account code?", "delivery": "dtmf"},
            typed,
            waiting_state=CallState.MENU,
        )
        if typed.strip(" \t-"):
            assert typed.strip() not in reply
        assert "0456" not in reply and "0456" not in " ".join(call.transcript)
        assert "send_dtmf" not in reply
        assert "The customer answered:" not in reply
        assert "Read numbers digit by digit" not in reply
        assert "keypad" in reply.lower() or "invalid" in reply.lower()
        assert call.session.state is CallState.MENU
    finally:
        await call.finish({"status": "completed"})


@pytest.mark.parametrize("separator", [" ", "\t", "\n", "-"])
async def test_ask_user_dtmf_cannot_bypass_high_sensitivity_guard(
    fake: FakeCartesia, separator: str
) -> None:
    call = await started_call(fake)
    await call.tool("report_state", {"state": "menu"})
    try:
        reply = await call.tool(
            "ask_user",
            {"question": "Full card number?", "sensitivity": "high", "delivery": "dtmf"},
        )
        assert reply.startswith("Not allowed")
        assert not call.requests.requests
        assert call.session.state is CallState.MENU

        card = separator.join(["4242"] * 4)
        reply = await answer_tool_request(
            call,
            {"question": "Account code?", "sensitivity": "medium", "delivery": "dtmf"},
            card,
            waiting_state=CallState.MENU,
        )
        assert card not in reply and "4242424242424242" not in reply
        assert "The customer answered:" not in reply and "send_dtmf" not in reply
        assert any(e.kind == "guard_denied" for e in call.recorder.events)
        assert call.session.state is CallState.MENU
    finally:
        await call.finish({"status": "completed"})


@pytest.mark.parametrize("prior_state", [CallState.MENU, CallState.IN_CONVERSATION])
async def test_ask_user_dtmf_timeout_preserves_state_and_retries_silently(
    fake: FakeCartesia, monkeypatch: pytest.MonkeyPatch, prior_state: CallState
) -> None:
    monkeypatch.setattr("backend.cartesia.call.ASK_USER_WAIT_S", 0.001)
    call = await started_call(fake)
    await call.tool(
        "report_state", {"state": "menu" if prior_state is CallState.MENU else "person"}
    )
    try:
        reply = await call.tool("ask_user", {"question": "Account code?", "delivery": "dtmf"})
        assert call.session.state is prior_state
        assert "call4me_ask_user" in reply
        assert "silent" in reply.lower() or "do not speak" in reply.lower()
        assert "Ask the rep to hold" not in reply
        (request,) = call.requests.requests.values()
        assert request.status is UserRequestStatus.TIMED_OUT
    finally:
        await call.finish({"status": "completed"})


@pytest.mark.parametrize(
    ("limits", "args", "allowed"),
    [
        ({}, {"kind": "plan_change", "description": "Prime trial", "amount_usd": 14.99}, False),
        (
            {"allow_plan_changes": True, "max_spend_usd": 20},
            {"kind": "plan_change", "description": "Prime", "amount_usd": 14.99},
            True,
        ),
        ({}, {"kind": "cancellation", "description": "cancel order", "amount_usd": 0}, False),
        ({"max_spend_usd": 5}, {"kind": "charge", "description": "fee", "amount_usd": 9}, False),
        ({"max_spend_usd": 10}, {"kind": "charge", "description": "fee", "amount_usd": 9}, True),
    ],
)
async def test_check_offer_follows_the_users_limits(
    fake: FakeCartesia, limits: dict[str, Any], args: dict[str, Any], allowed: bool
) -> None:
    call = await started_call(fake, **limits)
    reply = await call.tool("check_offer", args)
    assert reply.startswith("Allowed") is allowed
    await call.finish({"status": "completed"})


async def test_report_state_walks_the_state_machine(fake: FakeCartesia) -> None:
    call = await started_call(fake)
    await call.tool("report_state", {"state": "menu", "note": "pressed 2"})
    assert call.session.state is CallState.MENU
    await call.tool("report_state", {"state": "person", "note": "Alex answered"})
    assert call.session.state is CallState.IN_CONVERSATION
    await call.finish({"status": "completed"})


async def test_typed_message_rides_on_the_next_tool_result(fake: FakeCartesia) -> None:
    call = await started_call(fake)
    await call.type_text("Please email me the label.")
    reply = await call.tool("report_state", {"state": "person", "note": ""})
    assert "Please email me the label." in reply
    assert "Please email me the label." not in await call.tool(
        "report_state", {"state": "person", "note": ""}
    )
    await call.finish({"status": "completed"})


async def test_cancel_cancels_the_cartesia_call(fake: FakeCartesia) -> None:
    call = await started_call(fake)
    await call.cancel()
    assert fake.cancelled == ["ac_1"]
    await call.finish({"status": "completed", "end_reason": "api_cancelled"})


# --- Jev alongside the agent ---------------------------------------------------------


async def company_says(call: CartesiaCall, text: str) -> None:
    await call.on_event(
        {"type": "call_turn", "call_id": "ac_1", "turn": {"role": "user", "text": text}}
    )
    for _ in range(5):
        await asyncio.sleep(0)
    async with call._jev_lock:  # FIFO: queued checks have finished
        pass


def jev_events(call: CartesiaCall) -> list[Any]:
    return [e for e in call.recorder.events if e.kind == "jev_decision"]


async def test_jev_classifies_company_speech_and_moves_the_state(fake: FakeCartesia) -> None:
    call = await started_call(fake)  # no TYPESAFE key: Jev's keyword twin answers
    await company_says(call, "For orders, press 1. For returns and refunds, press 2.")
    assert call.session.state is CallState.MENU
    assert jev_events(call)[0].detail["choice"] == "menu"
    await call.finish({"status": "completed"})


async def test_jev_walks_menu_hold_person_then_stops(fake: FakeCartesia) -> None:
    jev = MockDecisionClient()
    for label in ("menu", "recorded_message", "human"):
        jev.script(jev_checks.STATE_CHECK, label, 0.9)
    call = await started_call(fake, jev)
    await company_says(call, "For orders, press 1. For returns and refunds, press 2.")
    assert call.session.state is CallState.MENU
    await company_says(call, "Your call is important to us. Please continue to hold.")
    assert call.session.state is CallState.RECORDED_MESSAGE
    await company_says(call, "Hi, my name is Alex. How can I help you today?")
    assert call.session.state is CallState.IN_CONVERSATION
    assert [e.detail["choice"] for e in jev_events(call)] == ["menu", "recorded_message", "human"]
    assert all(e.detail["question"] == jev_checks.STATE_CHECK for e in jev_events(call))
    # With a person on the line the agent leads; Jev stops checking.
    await company_says(call, "Press 1 if you want to hear that again.")
    assert len(jev_events(call)) == 3 and call.session.state is CallState.IN_CONVERSATION
    await call.finish({"status": "completed"})


async def test_unsure_jev_leaves_the_state_alone(fake: FakeCartesia) -> None:
    jev = MockDecisionClient()
    jev.script(jev_checks.STATE_CHECK, "hold_music", 0.4)
    jev.script(jev_checks.STATE_CHECK, "human", 0.7)  # under the stricter person bar
    call = await started_call(fake, jev)
    await company_says(call, "...")
    await company_says(call, "Hello?")
    assert call.session.state is CallState.DIALING
    assert len(jev_events(call)) == 2
    await call.finish({"status": "completed"})


async def test_agent_report_that_contradicts_jev_is_logged(fake: FakeCartesia) -> None:
    jev = MockDecisionClient()
    jev.script(jev_checks.STATE_CHECK, "hold_music", 0.9)
    call = await started_call(fake, jev)
    await company_says(call, "(music)")
    assert call.session.state is CallState.HOLD
    await call.tool("report_state", {"state": "person", "note": ""})
    assert call.session.state is CallState.IN_CONVERSATION  # the agent still moves it
    (d,) = [e for e in call.recorder.events if e.kind == "jev_disagreement"]
    assert d.detail == {"agent": "person", "jev": "hold_music", "probability": 0.9}
    await call.tool("report_state", {"state": "hold", "note": ""})  # agrees: nothing new
    assert len([e for e in call.recorder.events if e.kind == "jev_disagreement"]) == 1
    await call.finish({"status": "completed"})


async def test_menu_choice_asks_jev_for_the_key(fake: FakeCartesia) -> None:
    jev = MockDecisionClient()
    jev.script(jev_checks.MENU_CHOICE, "2", 0.91)
    call = await started_call(fake, jev)
    q = hub.subscribe(call.id)
    reply = await call.tool(
        "menu_choice", {"options": "1: orders\n2: returns and refunds\n0: representative"}
    )
    assert reply == "Press 2 with send_dtmf (returns and refunds)."
    (question, options, context) = jev.calls[-1]
    assert question == jev_checks.MENU_CHOICE and options == ["1", "2", "0"]
    assert context["goal"] == call.session.goal
    (event,) = [e for e in jev_events(call) if e.detail["question"] == jev_checks.MENU_CHOICE]
    assert event.detail["choice"] == "2" and event.confidence == 0.91
    shown = [
        m.data["text"] for m in [q.get_nowait() for _ in range(q.qsize())] if m.type == "summary"
    ]
    assert shown == ["Jev: Press 2 (returns and refunds), 91% sure"]
    hub.unsubscribe(call.id, q)
    await call.finish({"status": "completed"})


async def test_menu_choice_heuristic_and_unsure_answers(fake: FakeCartesia) -> None:
    call = await started_call(fake)  # keyword twin: goal words decide
    reply = await call.tool("menu_choice", {"options": "1: orders; 2: returns and refunds"})
    assert reply.startswith("Press 2 with send_dtmf")
    jev = MockDecisionClient()
    jev.script(jev_checks.MENU_CHOICE, "say:representative", 0.3)
    unsure = await started_call(fake, jev)
    reply = await unsure.tool(
        "menu_choice", {"options": "billing: a bill\nrepresentative: someone"}
    )
    assert reply.startswith('Say "representative" to the menu') and "not sure" in reply
    await call.finish({"status": "completed"})
    await unsure.finish({"status": "completed"})


async def test_menu_choice_can_act_on_one_eligible_option(fake: FakeCartesia) -> None:
    jev = MockDecisionClient()
    jev.script(jev_checks.MENU_CHOICE, "2", 0.96)
    call = await started_call(fake, jev)
    try:
        # A complete key/label pair is enough; no whole-menu/end-of-menu gate.
        reply = await call.tool("menu_choice", {"options": "2: returns and refunds"})
        assert reply == "Press 2 with send_dtmf (returns and refunds)."
        assert jev.calls[-1][1] == ["2"]
    finally:
        await call.finish({"status": "completed"})


async def test_menu_choice_falls_back_to_captions_and_skips_callbacks(fake: FakeCartesia) -> None:
    jev = MockDecisionClient()
    jev.script(jev_checks.STATE_CHECK, "callback_offer", 0.9)
    call = await started_call(fake, jev)
    await company_says(call, "To get a callback, press 1. To keep holding, press 2.")
    await call.tool("menu_choice", {"options": ""})
    (_, options, _) = jev.calls[-1]
    assert options == ["2"]  # read from the captions; the callback key is never offered
    await call.finish({"status": "completed"})


def test_agent_menu_lines_parse_keys_and_spoken_words() -> None:
    assert _agent_menu("1: orders\nPress 2: refunds; say billing: bills\nnonsense") == {
        "1": "orders",
        "2": "refunds",
        "say:billing": "bills",
    }


def test_agent_menu_commas_separate_keys_but_preserve_label_commas() -> None:
    assert _agent_menu(
        "2: billing, invoices and late fees, Press 3: technical support, "
        "*: hear options again, #: main menu"
    ) == {
        "2": "billing, invoices and late fees",
        "3": "technical support",
        "*": "hear options again",
        "#": "main menu",
    }
    assert _agent_menu("billing: bills, fees and payments, say representative: a person") == {
        "say:billing": "bills, fees and payments",
        "say:representative": "a person",
    }


async def test_comma_separated_menu_does_not_hide_later_matching_key(fake: FakeCartesia) -> None:
    jev = MockDecisionClient()
    call = await started_call(fake, jev)
    try:
        reply = await call.tool("menu_choice", {"options": "1: sales, 2: returns and refunds"})
        assert reply.startswith("Press 2 with send_dtmf")
        _, keys, context = jev.calls[-1]
        assert keys == ["1", "2"]
        assert context["option_descriptions"] == {"1": "sales", "2": "returns and refunds"}
    finally:
        await call.finish({"status": "completed"})


# --- HTTP endpoints --------------------------------------------------------------------


async def test_endpoints_check_the_shared_secret(client, fake: FakeCartesia) -> None:
    from backend.config import get_settings

    secret = cartesia_setup.shared_secret(get_settings())
    r = await client.post(
        "/cartesia/webhook", json={"type": "call_turn"}, headers={"X-Webhook-Secret": "nope"}
    )
    assert r.status_code == 401
    r = await client.post(
        "/cartesia/webhook", json={"call_id": "unknown"}, headers={"X-Webhook-Secret": secret}
    )
    assert r.status_code == 200 and r.json() == {"ok": False}
    r = await client.post("/cartesia/tools/report_state", json={"session_id": "x"})
    assert r.status_code == 401
    r = await client.post(
        "/cartesia/tools/report_state",
        json={"session_id": "gone", "state": "menu", "note": ""},
        headers={"Authorization": f"Bearer {secret}"},
    )
    assert r.status_code == 200 and "no longer active" in r.text


async def test_phone_numbers_are_normalized(client) -> None:
    base = {
        "company": "Amazon Customer Service",
        "goal": "Refund",
        "disclosure_text": "Hi, I'm an AI assistant.",
    }
    r = await client.post("/calls", json={**base, "phone_number": "(415) 555-1234"})
    assert r.status_code == 201 and r.json()["phone_number"] == "+14155551234"
    r = await client.post("/calls", json={**base, "phone_number": "555-12"})
    assert r.status_code == 422


def test_spec_instructions_use_every_call_variable() -> None:
    for name in ("company", "goal", "limits", "known_info", "disclosure"):
        assert "{{" + name + "}}" in spec.INSTRUCTIONS


def test_tool_schemas_never_require_injected_fields() -> None:
    # Cartesia: "A parameter with constant_value or dynamic_variable cannot be required".
    from backend.cartesia import spec

    for t in spec.tool_specs("https://x.example", "s"):
        body = t["api_schema"]["request_body_schema"]
        injected = {
            k
            for k, v in body["properties"].items()
            if "dynamic_variable" in v or "constant_value" in v
        }
        assert injected and not injected & set(body["required"]), t["name"]
