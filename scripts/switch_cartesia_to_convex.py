"""Point the existing Cartesia tools and event webhook at Convex.

This deliberately does not update the agent. Its instructions, model, voice,
tool assignments and all other configuration stay exactly as they are.
"""

from __future__ import annotations

import asyncio
import os
import sys

from backend.cartesia.api import CartesiaAgentsApi
from backend.cartesia.setup import shared_secret
from backend.config import get_settings

BASE = os.environ.get("CONVEX_SITE_URL", "https://nautical-wolverine-162.convex.site").rstrip("/")
AGENT_ID = os.environ.get("CARTESIA_AGENT_ID", "agent_ezr5DYuZz9vfGodtq95Ex5")
TOOLS = {"ask_user", "check_offer", "menu_choice", "report_state", "finish"}


async def main() -> None:
    settings = get_settings()
    api = CartesiaAgentsApi(settings.cartesia_api_key)
    try:
        agent = await api._req("GET", f"/v1/agents/{AGENT_ID}", "read agent")
        original_config = agent["config"]
        assigned = {entry["id"] for entry in original_config["tools"]}
        tools = [tool for tool in await api.list_tools()
                 if tool.get("name") in {f"call4me_{name}" for name in TOOLS}]
        if len(tools) != len(TOOLS) or {tool["id"] for tool in tools} != assigned:
            raise RuntimeError(
                "Existing agent tools differ from the expected five; no changes made"
            )
        hooks = [hook for hook in await api.list_webhooks()
                 if hook.get("display_name") == "call4me-events"]
        if len(hooks) != 1 or original_config.get("event_webhook_id") != hooks[0]["id"]:
            raise RuntimeError("Existing agent webhook differs from expected; no changes made")

        secret = shared_secret(settings)
        for tool in tools:
            schema = dict(tool["api_schema"])
            schema["url"] = f"{BASE}/cartesia/tools/{tool['name'].removeprefix('call4me_')}"
            schema["authentication"] = {
                "mode": "bearer",
                "token": {
                    "type": "secret", "secret_description": "call4me tool secret",
                    "secret_value": secret,
                },
            }
            await api.update_tool(tool["id"], {"api_schema": schema})
        await api.update_webhook(hooks[0]["id"], f"{BASE}/cartesia/webhook", secret)

        verified = await api._req("GET", f"/v1/agents/{AGENT_ID}", "verify agent")
        if verified["config"] != original_config:
            raise RuntimeError("Agent config changed unexpectedly; inspect immediately")
        print("Cartesia webhook and five assigned tools now use the configured Convex URL.")
        print("Agent instructions, model, voice and tool assignments are unchanged.")
    finally:
        await api.aclose()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        print(f"Cartesia endpoint switch failed: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
