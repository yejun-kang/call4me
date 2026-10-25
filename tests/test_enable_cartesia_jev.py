from __future__ import annotations

import copy
from typing import Any

import pytest

from backend.cartesia import spec
from scripts.enable_cartesia_jev import MENU_NAME, NEW_MENU, OLD_MENU, enable

SITE = "https://example.convex.site"


class MigrationApi:
    def __init__(self, *, existing_menu: bool = True, enabled: bool = False) -> None:
        definitions = spec.tool_specs(SITE, "test-secret")
        self.tools = [
            {"id": tool["name"], **copy.deepcopy(tool)}
            for tool in definitions
            if existing_menu or tool["name"] != MENU_NAME
        ]
        self.config = {
            "instructions": spec.INSTRUCTIONS if enabled else spec.INSTRUCTIONS.replace(
                NEW_MENU, OLD_MENU, 1
            ),
            "tools": [{"id": tool["id"]} for tool in self.tools
                      if enabled or tool["name"] != MENU_NAME],
            "model": {"id": "claude-haiku-4.5", "max_output_tokens": 300},
            "audio": {"output": {"voice_id": "keep-this-voice"}},
            "system_tools": {"send_dtmf": {"pre_tool_speech": "off"}},
            "turn": {"inactivity_end_call_secs": 240},
            "event_webhook_id": "keep-this-webhook",
        }
        self.writes: list[tuple[str, str, Any]] = []
        self.corrupt_voice = False

    async def _req(self, method: str, path: str, what: str) -> dict[str, Any]:
        assert method == "GET"
        config = copy.deepcopy(self.config)
        if what == "verify agent" and self.corrupt_voice:
            config["audio"]["output"]["voice_id"] = "changed"
        return {"config": config}

    async def list_tools(self) -> list[dict[str, Any]]:
        return copy.deepcopy(self.tools)

    async def update_tool(self, tool_id: str, body: dict[str, Any]) -> None:
        self.writes.append(("tool", tool_id, body))
        next(tool for tool in self.tools if tool["id"] == tool_id).update(body)

    async def create_tool(self, body: dict[str, Any]) -> dict[str, Any]:
        tool = {"id": "new-menu", **copy.deepcopy(body)}
        self.writes.append(("create", "new-menu", body))
        self.tools.append(tool)
        return tool

    async def update_agent(self, agent_id: str, body: dict[str, Any]) -> None:
        self.writes.append(("agent", agent_id, body))
        self.config.update(copy.deepcopy(body["config"]))


async def run(api: MigrationApi, *, apply: bool = False) -> dict[str, Any]:
    return await enable(
        api, agent_id="test-agent", base_url=SITE, secret="test-secret", apply=apply
    )


async def test_dry_run_never_mutates_provider() -> None:
    api = MigrationApi()
    plan = await run(api)
    assert plan["replace_menu_paragraph"] and plan["add_menu_assignment"]
    assert api.writes == []
    assert "test-secret" not in str(plan)


@pytest.mark.parametrize("existing_menu", [True, False])
async def test_apply_only_changes_menu_tool_and_two_agent_fields(existing_menu: bool) -> None:
    api = MigrationApi(existing_menu=existing_menu)
    before = copy.deepcopy(api.config)
    other_tools = [copy.deepcopy(t) for t in api.tools if t["name"] != MENU_NAME]
    result = await run(api, apply=True)
    assert result["verified"]
    assert api.config["instructions"] == spec.INSTRUCTIONS
    assert len(api.config["tools"]) == 5
    for key in before.keys() - {"instructions", "tools"}:
        assert api.config[key] == before[key]
    assert [t for t in api.tools if t["name"] != MENU_NAME] == other_tools
    assert len(api.writes) == 2
    assert set(api.writes[-1][2]["config"]) == {"instructions", "tools"}


async def test_already_enabled_does_not_rewrite_agent() -> None:
    api = MigrationApi(enabled=True)
    assert (await run(api, apply=True))["verified"]
    assert [kind for kind, _, _ in api.writes] == ["tool"]


async def test_unrecognized_prompt_is_rejected_without_mutation() -> None:
    api = MigrationApi()
    api.config["instructions"] += "\nA teammate changed another rule."
    with pytest.raises(RuntimeError, match="instructions differ"):
        await run(api, apply=True)
    assert api.writes == []


@pytest.mark.parametrize("change", ["extra", "missing", "duplicate"])
async def test_unrecognized_tool_assignments_are_rejected(change: str) -> None:
    api = MigrationApi()
    if change == "extra":
        api.config["tools"].append({"id": "unknown"})
    elif change == "missing":
        api.config["tools"].pop()
    else:
        api.config["tools"].append(copy.deepcopy(api.config["tools"][0]))
    with pytest.raises(RuntimeError, match="Assigned tools"):
        await run(api, apply=True)
    assert api.writes == []


async def test_provider_configuration_drift_fails_verification() -> None:
    api = MigrationApi()
    api.corrupt_voice = True
    with pytest.raises(RuntimeError, match="verification failed"):
        await run(api, apply=True)
