from collections.abc import AsyncIterator

import httpx  # resolves to httpx2 (see tests/_alias_httpx.py); typed for respx
import pytest
import respx

from picloud_api.agent_client import AgentClient, AgentUnavailableError
from tests.conftest import AGENT_URL, SNAPSHOT, FakeClock, snapshot_data

SNAPSHOT_URL = f"{AGENT_URL}/v1/snapshot"


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
async def agent(clock: FakeClock) -> AsyncIterator[AgentClient]:
    client = AgentClient(AGENT_URL, cache_ttl_s=1.0, clock=clock)
    yield client
    await client.aclose()


@respx.mock
async def test_parses_the_contract_snapshot(agent: AgentClient) -> None:
    respx.get(SNAPSHOT_URL).respond(200, json=SNAPSHOT)
    snapshot = await agent.snapshot()
    assert snapshot.hostname == "picloud"
    assert snapshot.cpu.temperature_celsius == 51.2
    assert snapshot.throttling.under_voltage_occurred is True
    assert snapshot.model_dump(mode="json")["collected_at"] == "2026-10-02T12:00:00Z"


@respx.mock
async def test_accepts_nulls_and_ignores_unknown_fields(agent: AgentClient) -> None:
    data = snapshot_data(extra_field="ignored")
    data["cpu"] = {**SNAPSHOT["cpu"], "temperature_celsius": None, "frequency_mhz": None}
    respx.get(SNAPSHOT_URL).respond(200, json=data)
    snapshot = await agent.snapshot()
    assert snapshot.cpu.temperature_celsius is None


@respx.mock
async def test_caches_for_the_ttl(agent: AgentClient, clock: FakeClock) -> None:
    route = respx.get(SNAPSHOT_URL).respond(200, json=SNAPSHOT)
    await agent.snapshot()
    clock.advance(0.5)
    await agent.snapshot()
    assert route.call_count == 1
    clock.advance(0.5)
    await agent.snapshot()
    assert route.call_count == 2


@respx.mock
async def test_failures_are_cached_too(agent: AgentClient, clock: FakeClock) -> None:
    route = respx.get(SNAPSHOT_URL).mock(side_effect=httpx.ConnectError("refused"))
    for _ in range(2):
        with pytest.raises(AgentUnavailableError, match=r"request failed \(ConnectError\)"):
            await agent.snapshot()
    assert route.call_count == 1
    clock.advance(1.0)
    route.mock(side_effect=None, return_value=httpx.Response(200, json=SNAPSHOT))
    assert (await agent.snapshot()).hostname == "picloud"


@respx.mock
async def test_http_error(agent: AgentClient) -> None:
    respx.get(SNAPSHOT_URL).respond(503, json={"status": "starting"})
    with pytest.raises(AgentUnavailableError, match="HTTP 503"):
        await agent.snapshot()


@respx.mock
async def test_invalid_snapshot(agent: AgentClient) -> None:
    respx.get(SNAPSHOT_URL).respond(200, json={"hostname": "picloud"})
    with pytest.raises(AgentUnavailableError, match="invalid snapshot"):
        await agent.snapshot()
