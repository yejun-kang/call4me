"""The call4me agent as Cartesia runs it: instructions, tools, voice, turn settings.

Cartesia handles the phone line, listening, speaking, and turn-taking; Claude (via
Cartesia's managed models) decides what to say. Our server stays in the loop
through webhook tools (ask the user, check an offer against the user's limits,
pick a menu option with Jev, report progress, record the outcome) and the per-turn
call webhook (captions, plus a Jev state check on each company utterance).

Per-call facts arrive as dynamic variables, filled when we start the call.
"""

from __future__ import annotations

from typing import Any

AGENT_NAME = "call4me"
WEBHOOK_NAME = "call4me-events"
NUMBER_LABEL = "call4me outbound"
TOOL_PREFIX = "call4me_"

# Seconds our server holds an ask_user request open waiting for the user to type.
# Cartesia allows up to 120 for a webhook tool; keep a margin for the round trip.
ASK_USER_TOOL_TIMEOUT_S = 110
ASK_USER_WAIT_S = 95

INSTRUCTIONS = """\
You are call4me, an AI assistant on a live phone call to {{company}}. You are calling \
on behalf of a Deaf or hard-of-hearing customer who follows the call through live \
captions and answers by typing. You speak for them.

All response text is spoken aloud to the company. Output only words intended for \
that listener: never output internal reasoning, stage directions, tool names, or \
descriptions of tool use. Invoke tools through tool calls, not spoken text. To wait \
silently, invoke skip_turn with no spoken text; never say its name.

<goal>{{goal}}</goal>
<limits>{{limits}}</limits>
<known_info>{{known_info}}</known_info>

Part 1: the automated phone system.
- When a menu lists options, call call4me_menu_choice with the options you heard. \
Jev returns the key to press (or word to say): follow it with send_dtmf (or say it, \
if the menu asks you to speak). Only if the result says it is not sure and another \
option clearly fits the goal better, choose that one; prefer reaching a live person. \
Call call4me_report_state with state "menu" and a note the customer will read, \
giving the key and why. Keep that explanation in the note, never in spoken text.
- During automated menus, use tools silently. Speak only if the system requests \
a spoken response.
- When asked to enter digits using the keypad, use send_dtmf, never read the digits \
aloud. Use known_info if available; otherwise silently call call4me_ask_user with \
delivery "dtmf". Preserve leading zeroes. Add # or * only when explicitly requested, \
and only once.
- While on hold (music, "please hold", recorded announcements), stay silent: use \
skip_turn and call call4me_report_state with state "hold". Never talk to a recording.

Part 2: a live person answers.
- The moment a person speaks to you, call call4me_report_state with state "person", \
then say exactly this introduction first: "{{disclosure}}" Then say in one short \
sentence why you are calling.
- Keep every reply to one or two short, natural sentences. One thing at a time.

Rules. Follow them strictly; the customer relies on you.
1. Only state facts that are in the goal or known_info, or that the customer gave you. \
Never guess account numbers, names, addresses, dates, or anything else.
2. Give known_info items only when asked for them. For a keypad request use \
send_dtmf. For a spoken request, read numbers slowly, digit by digit, in groups.
3. If the rep needs anything else from the customer (a code, a choice, a detail), say \
"One moment, let me check with my client." and call call4me_ask_user. Then tell the \
rep exactly what the customer answered. If the tool says there is no answer yet, ask \
the rep to hold a little longer and call it again. For keypad requests instead, \
stay silent and call call4me_ask_user with delivery "dtmf", then use send_dtmf with \
the answer. Never say the keypad answer or a waiting announcement aloud.
4. Never ask for or say a full card number, Social Security number, or password. Tell \
the rep the customer will provide it another way.
5. Before agreeing to anything that costs money, changes a plan or subscription, \
cancels something, or adds anything the goal did not ask for, call call4me_check_offer \
and follow its answer. If it is not allowed, politely decline and return to the goal.
6. Tool results may include a message from the customer. Say it to the rep right \
away, word for word.
7. Before ending, read back the key details (amounts, dates, the reference number) \
and ask if there is anything else. Then call call4me_finish with a plain summary for \
the customer.
8. Never hang up on someone. End the call only when it is finished for both sides \
(the rep said goodbye or confirmed there is nothing else) or the rep has gone silent \
and did not answer after you asked "Are you still there?" twice.
"""

# Sample values so the agent can be tried in the Cartesia Playground.
PLAYGROUND_SAMPLES: dict[str, str] = {
    "session_id": "playground",
    "company": "Amazon Customer Service",
    "goal": "Get a refund for wireless headphones that arrived damaged.",
    "limits": "No new charges or subscriptions. No plan changes. No cancellations.",
    "known_info": "Order number: 112-4567890-1234567",
    "disclosure": "Hi, I'm an AI assistant calling on behalf of my client, who is Deaf. "
    "They are following this call by text.",
}


def _session_field() -> dict[str, Any]:
    # Filled by Cartesia from the call's dynamic variables; the model never sees it.
    return {"type": "string", "dynamic_variable": "session_id"}


def tool_specs(base_url: str, secret: str) -> list[dict[str, Any]]:
    """Webhook tools that call back into our server (POST /cartesia/tools/<name>)."""

    def tool(
        name: str,
        description: str,
        props: dict[str, Any],
        required: list[str],
        *,
        timeout: int = 10,
        pre_tool_speech: str = "off",
    ) -> dict[str, Any]:
        return {
            "type": "webhook",
            "name": TOOL_PREFIX + name,
            "description": description,
            "pre_tool_speech": pre_tool_speech,
            "execution_mode": "immediate",
            "response_timeout_secs": timeout,
            "api_schema": {
                "url": f"{base_url.rstrip('/')}/cartesia/tools/{name}",
                "method": "POST",
                "authentication": {
                    "mode": "bearer",
                    "token": {
                        "type": "secret",
                        "secret_description": "call4me tool secret",
                        "secret_value": secret,
                    },
                },
                "request_body_schema": {
                    "type": "object",
                    "properties": {"session_id": _session_field(), **props},
                    # Cartesia rejects dynamic_variable fields in `required`; it always
                    # fills session_id itself.
                    "required": list(required),
                },
            },
        }

    return [
        tool(
            "ask_user",
            "Ask the customer for something only they know (a code, a detail, a decision). "
            "They type the answer; you get it back as text. Can take up to a minute and a "
            "half. For spoken requests, say 'One moment, let me check with my client.' "
            "before calling. For keypad requests, stay silent and set delivery to dtmf.",
            {
                "question": {
                    "type": "string",
                    "description": "Short, plain question shown on the customer's screen.",
                },
                "sensitivity": {
                    "type": "string",
                    "enum": ["low", "medium", "high"],
                    "description": "low: order number, ZIP, email. medium: PIN, account "
                    "number, date of birth. high: full card number, SSN, password.",
                },
                "delivery": {
                    "type": "string",
                    "enum": ["speech", "dtmf"],
                    "description": "dtmf when asked to enter or press digits on the keypad; "
                    "speech when asked to say or read an answer. Defaults to speech.",
                },
            },
            ["question", "sensitivity"],
            timeout=ASK_USER_TOOL_TIMEOUT_S,
        ),
        tool(
            "check_offer",
            "Check whether the customer's limits allow something before you agree to it: "
            "a charge, a plan or subscription change, a cancellation, or anything not in "
            "the goal. Follow the answer.",
            {
                "kind": {
                    "type": "string",
                    "enum": ["charge", "plan_change", "cancellation", "other"],
                    "description": "What the rep is offering or asking you to agree to.",
                },
                "description": {"type": "string", "description": "The offer in a few words."},
                "amount_usd": {
                    "type": "number",
                    "description": "Cost in US dollars if any (monthly price for plans), else 0.",
                },
            },
            ["kind", "description", "amount_usd"],
        ),
        tool(
            "menu_choice",
            "Ask Jev which menu option fits the goal using the options heard so far. Returns "
            "the key to press or the word to say. Silent: say nothing while calling it.",
            {
                "options": {
                    "type": "string",
                    "description": "Options you heard, one per line as key: label, "
                    "e.g. '1: orders' then '2: returns and refunds' then '0: "
                    "representative'. If the menu asks you to speak, use the word to say "
                    "as the key, e.g. 'billing: questions about a bill'.",
                },
            },
            ["options"],
            timeout=5,
        ),
        tool(
            "report_state",
            "Tell the customer's screen where the call is: in a phone menu, on hold, or "
            "talking to a person.",
            {
                "state": {"type": "string", "enum": ["menu", "hold", "person"]},
                "note": {
                    "type": "string",
                    "description": "A few words, e.g. 'pressed 2 for refunds'.",
                },
            },
            ["state", "note"],
            timeout=5,
        ),
        tool(
            "finish",
            "Record the outcome for the customer, after reading back the details and "
            "before saying goodbye.",
            {
                "summary": {
                    "type": "string",
                    "description": "Plain-language outcome: what was done or agreed.",
                },
                "reference_number": {
                    "type": "string",
                    "description": "Reference or confirmation number the rep gave, or ''.",
                },
            },
            ["summary", "reference_number"],
            timeout=5,
        ),
    ]


def agent_config(*, voice_id: str, model_id: str, tool_ids: list[str]) -> dict[str, Any]:
    return {
        "instructions": INSTRUCTIONS,
        # The company answers first ("Thank you for calling..."); wait for it.
        "initial_message": None,
        "language": {"primary": "en"},
        "model": {"id": model_id, "max_output_tokens": 300},
        "audio": {
            "input": {
                "noise_suppression": "auto",
                "keyterms": ["representative", "associate", "agent", "refund", "order number"],
            },
            "output": {"voice_id": voice_id},
        },
        "system_tools": {
            "end_call": {
                "description": "End the call only when it is finished for both sides (the "
                "rep said goodbye or confirmed there is nothing else), or the rep did not "
                "answer after you asked 'Are you still there?' twice. Never on a recording "
                "or while on hold.",
                "pre_tool_speech": "auto",
            },
            "send_dtmf": {"pre_tool_speech": "off"},
            # On hold: wait silently without "are you there?" check-ins.
            "skip_turn": {"wait_timeout_secs": -1, "pre_tool_speech": "off"},
            # A phone menu can sound like voicemail; don't let detection hang up on it.
            "voicemail_detection": None,
        },
        "tools": [{"id": t} for t in tool_ids],
        "turn": {"inactivity_end_call_secs": 240, "inactivity_check_in_secs": 20},
        "dynamic_variable_placeholders": PLAYGROUND_SAMPLES,
    }
