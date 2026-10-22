"""Health, readiness, system, providers and metrics endpoints."""

from collections.abc import AsyncGenerator
from typing import cast

import httpx  # resolves to httpx2 (see tests/_alias_httpx.py); typed for respx
import respx

from picloud_api.agent_client import AgentClient
from picloud_api.routes.system import snapshot_events, stream_system
from picloud_api.services import Services
from tests.conftest import (
    AGENT_URL,
    SNAPSHOT,
    FakeProvider,
    build_app,
    ok_reply,
    parse_sse,
    serve,
    slot,
)

SNAPSHOT_URL = f"{AGENT_URL}/v1/snapshot"

CONTRACT_METRICS = (
    "picloud_http_requests_total",
    "picloud_http_request_duration_seconds",
    "picloud_chat_requests_total",
    "picloud_chat_tokens_total",
    "picloud_chat_ttft_seconds",
    "picloud_chat_duration_seconds",
    "picloud_provider_fallbacks_total",
    "picloud_provider_circuit_state",
    "picloud_build_info",
)


async def test_health() -> None:
    async with serve(build_app()) as client:
        response = await client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["version"] == "2.0.0"
    assert isinstance(body["uptime_seconds"], float)
    assert len(response.headers["x-request-id"]) == 32


async def test_request_id_is_propagated_only_when_safe() -> None:
    async with serve(build_app()) as client:
        kept = await client.get("/api/health", headers={"X-Request-ID": "gw-123.abc"})
        replaced = await client.get("/api/health", headers={"X-Request-ID": "bad id\nInjected"})
    assert kept.headers["x-request-id"] == "gw-123.abc"
    assert replaced.headers["x-request-id"] != "bad id\nInjected"


@respx.mock
async def test_ready_when_agent_and_a_provider_are_up() -> None:
    respx.get(SNAPSHOT_URL).respond(200, json=SNAPSHOT)
    app = build_app([slot(FakeProvider("ollama", [ok_reply("x")], local=True))])
    async with serve(app) as client:
        response = await client.get("/api/ready")
    assert response.status_code == 200
    assert response.json() == {"status": "ready", "checks": {"agent": "ok", "providers": "ok"}}


@respx.mock
async def test_ready_is_degraded_when_agent_down_and_no_providers() -> None:
    respx.get(SNAPSHOT_URL).mock(side_effect=httpx.ConnectError("refused"))
    async with serve(build_app([slot(None, "ollama")])) as client:
        response = await client.get("/api/ready")
    assert response.status_code == 503
    assert response.json() == {
        "status": "degraded",
        "checks": {
            "agent": "error: agent request failed (ConnectError)",
            "providers": "none enabled",
        },
    }


@respx.mock
async def test_system_passes_the_snapshot_through() -> None:
    respx.get(SNAPSHOT_URL).respond(200, json=SNAPSHOT)
    async with serve(build_app()) as client:
        response = await client.get("/api/system")
    assert response.status_code == 200
    assert response.json() == SNAPSHOT


@respx.mock
async def test_system_returns_503_when_agent_fails() -> None:
    respx.get(SNAPSHOT_URL).respond(500)
    async with serve(build_app()) as client:
        response = await client.get("/api/system")
    assert response.status_code == 503
    assert response.json() == {"detail": "agent unavailable"}


@respx.mock
async def test_system_returns_503_when_snapshot_is_invalid() -> None:
    respx.get(SNAPSHOT_URL).respond(200, json={**SNAPSHOT, "cpu": {"cores": "four"}})
    async with serve(build_app()) as client:
        response = await client.get("/api/system")
    assert response.status_code == 503


@respx.mock
async def test_snapshot_events_yield_snapshot_then_error() -> None:
    respx.get(SNAPSHOT_URL).mock(
        side_effect=[httpx.Response(200, json=SNAPSHOT), httpx.Response(502)]
    )
    agent = AgentClient(AGENT_URL, cache_ttl_s=0)
    sleeps: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    events = snapshot_events(agent, 2.0, sleep=fake_sleep)
    try:
        first, second = await anext(events), await anext(events)
    finally:
        await events.aclose()
        await agent.aclose()

    assert parse_sse(first) == [("snapshot", SNAPSHOT)]
    assert parse_sse(second) == [("error", {"detail": "agent returned HTTP 502"})]
    assert sleeps == [2.0]


@respx.mock
async def test_system_stream_response_headers() -> None:
    respx.get(SNAPSHOT_URL).respond(200, json=SNAPSHOT)
    app = build_app()
    async with app.router.lifespan_context(app):
        services: Services = app.state.services
        response = await stream_system(services)
        assert response.media_type == "text/event-stream"
        assert response.headers["cache-control"] == "no-cache"
        assert response.headers["x-accel-buffering"] == "no"
        body = cast(AsyncGenerator[str, None], response.body_iterator)
        first = await anext(body)
        await body.aclose()
    assert first.startswith("event: snapshot\n")


async def test_providers_in_fallback_order() -> None:
    providers = [
        slot(FakeProvider("ollama", [ok_reply("x")], local=True, model="llama3.2:1b")),
        slot(None, "anthropic"),
        slot(FakeProvider("openai", [ok_reply("x")], model="gpt-4o-mini")),
    ]
    async with serve(build_app(providers)) as client:
        response = await client.get("/api/providers")
    assert response.status_code == 200
    assert response.json() == [
        {
            "name": "ollama",
            "enabled": True,
            "local": True,
            "model": "llama3.2:1b",
            "circuit": "closed",
        },
        {
            "name": "anthropic",
            "enabled": False,
            "local": False,
            "model": "anthropic-model",
            "circuit": "closed",
        },
        {
            "name": "openai",
            "enabled": True,
            "local": False,
            "model": "gpt-4o-mini",
            "circuit": "closed",
        },
    ]


@respx.mock
async def test_metrics_exposes_contract_names_with_route_templates() -> None:
    respx.get(SNAPSHOT_URL).respond(200, json=SNAPSHOT)
    app = build_app([slot(FakeProvider("ollama", [ok_reply("hi")], local=True))])
    async with serve(app) as client:
        await client.get("/api/system")
        await client.get("/does-not-exist")
        await client.request("PROBE1", "/does-not-exist")
        await client.request("PROBE2", "/does-not-exist")
        await client.post(
            "/api/chat", json={"messages": [{"role": "user", "content": "hi"}], "stream": False}
        )
        response = await client.get("/metrics")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    text = response.text
    for name in CONTRACT_METRICS:
        assert f"# TYPE {name.removesuffix('_total')}" in text, name
    assert 'picloud_http_requests_total{method="GET",route="/api/system",status="200"} 1.0' in text
    assert 'picloud_http_requests_total{method="GET",route="unmatched",status="404"} 1.0' in text
    # Arbitrary method tokens share one label value, so they cannot grow the series count.
    assert 'picloud_http_requests_total{method="OTHER",route="unmatched",status="404"} 2.0' in text
    assert "PROBE1" not in text
    assert 'picloud_chat_requests_total{outcome="success",provider="ollama"} 1.0' in text
    assert 'picloud_chat_tokens_total{direction="input",provider="ollama"} 12.0' in text
    assert 'picloud_provider_circuit_state{provider="ollama"} 0.0' in text
    assert 'picloud_build_info{version="2.0.0"} 1.0' in text
    assert "process_" in text or "python_info" in text
    assert "_created" not in text


async def test_cors_is_off_by_default_and_configurable() -> None:
    preflight = {
        "Origin": "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-api-key",
    }
    async with serve(build_app()) as client:
        closed = await client.options("/api/chat", headers=preflight)
    async with serve(build_app(cors_origins="http://localhost:5173")) as client:
        opened = await client.options("/api/chat", headers=preflight)
    assert "access-control-allow-origin" not in closed.headers
    assert opened.status_code == 200
    assert opened.headers["access-control-allow-origin"] == "http://localhost:5173"


async def test_openapi_docs_live_under_api() -> None:
    async with serve(build_app()) as client:
        response = await client.get("/api/openapi.json")
    assert response.status_code == 200
    assert "/api/chat" in response.json()["paths"]
