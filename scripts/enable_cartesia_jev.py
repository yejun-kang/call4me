"""Restore only Jev menu selection on an existing Cartesia agent.

Default: inspect and print a safe plan. Add --apply to update the menu tool and
the agent's menu instruction paragraph/tool assignment. No phone calls are made.
"""

from __future__ import annotations

import argparse
import asyncio
import copy
import json
import os
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.cartesia import spec  # noqa: E402
from backend.cartesia.api import CartesiaAgentsApi, CartesiaApiError  # noqa: E402
from backend.cartesia.setup import shared_secret  # noqa: E402
from backend.config import get_settings  # noqa: E402

DEFAULT_SITE = "https://nautical-wolverine-162.convex.site"
DEFAULT_AGENT = "agent_ezr5DYuZz9vfGodtq95Ex5"
EXISTING_TOOLS = {
    "call4me_ask_user", "call4me_check_offer", "call4me_report_state", "call4me_finish"
}
MENU_NAME = "call4me_menu_choice"
OLD_MENU = (
    "- When a menu lists options, pick the one that best fits the goal and press it with "
    "send_dtmf (or say it, if the menu asks you to speak). Prefer reaching a live person. "
    'Call call4me_report_state with state "menu".\n'
)
NEW_MENU = (
    "- When a menu lists options, call call4me_menu_choice with the options you heard. "
    "Jev returns the key to press (or word to say): follow it with send_dtmf (or say it, "
    "if the menu asks you to speak). Only if the result says it is not sure and another "
    "option clearly fits the goal better, choose that one; prefer reaching a live person. "
    'Call call4me_report_state with state "menu" and a note the customer will read, '
    "giving the key and why. Keep that explanation in the note, never in spoken text.\n"
)


def restored_instructions(current: str) -> str:
    """Accept exactly the reviewed old/new prompt, never overwrite other edits."""
    if spec.INSTRUCTIONS.count(NEW_MENU) != 1:
        raise RuntimeError("Local menu instructions changed; review the migration helper")
    old = spec.INSTRUCTIONS.replace(NEW_MENU, OLD_MENU, 1)
    if current == spec.INSTRUCTIONS:
        return current
    if current != old:
        raise RuntimeError("Live instructions differ from the reviewed versions; no changes made")
    return current.replace(OLD_MENU, NEW_MENU, 1)


async def enable(
    api: CartesiaAgentsApi,
    *,
    agent_id: str,
    base_url: str,
    secret: str,
    apply: bool = False,
) -> dict[str, Any]:
    base_url = base_url.rstrip("/")
    url = urlsplit(base_url)
    if (
        url.scheme != "https"
        or not url.hostname
        or not url.hostname.endswith(".convex.site")
        or url.username or url.password or url.port
        or url.path or url.query or url.fragment
    ):
        raise RuntimeError("CONVEX_SITE_URL must be an HTTPS Convex site origin")
    agent = await api._req("GET", f"/v1/agents/{agent_id}", "read agent")
    before = copy.deepcopy(agent["config"])
    instructions = restored_instructions(before.get("instructions", ""))
    tools = await api.list_tools()
    by_id = {tool["id"]: tool for tool in tools}
    assigned = before.get("tools", [])
    assigned_ids = [entry["id"] for entry in assigned]
    assigned_names = [by_id.get(tool_id, {}).get("name") for tool_id in assigned_ids]
    if (
        len(set(assigned_ids)) != len(assigned_ids)
        or len(set(assigned_names)) != len(assigned_names)
        or set(assigned_names) not in (EXISTING_TOOLS, EXISTING_TOOLS | {MENU_NAME})
    ):
        raise RuntimeError("Assigned tools differ from the reviewed four or five; no changes made")
    candidates = [tool for tool in tools if tool.get("name") == MENU_NAME]
    if len(candidates) > 1:
        raise RuntimeError("Multiple menu tools exist; no changes made")
    menu_id = candidates[0]["id"] if candidates else None
    definition = next(
        tool for tool in spec.tool_specs(base_url, secret) if tool["name"] == MENU_NAME
    )
    plan = {
        "apply": apply,
        "agent_id": agent_id,
        "menu_tool": "update existing" if menu_id else "create",
        "menu_tool_id": menu_id,
        "menu_url": definition["api_schema"]["url"],
        "replace_menu_paragraph": instructions != before["instructions"],
        "add_menu_assignment": menu_id not in assigned_ids,
        "preserve": "model, voice, other instructions, four existing tools, and all other config",
    }
    if not apply:
        return plan

    # Do not use setup.ensure(): it rewrites the entire agent and every tool.
    if menu_id:
        await api.update_tool(menu_id, {k: v for k, v in definition.items() if k != "type"})
    else:
        menu_id = (await api.create_tool(definition))["id"]
    expected = copy.deepcopy(before)
    expected["instructions"] = instructions
    if menu_id not in assigned_ids:
        expected["tools"].append({"id": menu_id})
    if expected != before:
        await api.update_agent(agent_id, {"config": {
            "instructions": expected["instructions"],
            "tools": expected["tools"],
        }})
    verified = await api._req("GET", f"/v1/agents/{agent_id}", "verify agent")
    if verified["config"] != expected:
        raise RuntimeError(
            "Agent verification failed: inspect configuration before further changes"
        )
    plan.update(menu_tool_id=menu_id, verified=True)
    return plan


async def main(apply: bool) -> None:
    settings = get_settings()
    if not settings.cartesia_api_key:
        raise RuntimeError("CARTESIA_API_KEY is not set")
    api = CartesiaAgentsApi(settings.cartesia_api_key)
    try:
        plan = await enable(
            api,
            agent_id=os.environ.get("CARTESIA_AGENT_ID", DEFAULT_AGENT),
            base_url=os.environ.get("CONVEX_SITE_URL", DEFAULT_SITE),
            secret=shared_secret(settings),
            apply=apply,
        )
        print(json.dumps(plan, indent=2))
    finally:
        await api.aclose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    try:
        asyncio.run(main(args.apply))
    except CartesiaApiError as exc:
        # Provider error bodies may echo credentials; never print them.
        print(f"Cartesia request failed (HTTP {exc.status}).", file=sys.stderr)
        raise SystemExit(1) from None
    except Exception as exc:
        print(f"Jev restoration failed: {type(exc).__name__}", file=sys.stderr)
        raise SystemExit(1) from None
