import asyncio
import copy
import json
import os
from collections.abc import AsyncGenerator, AsyncIterator, Sequence
from contextlib import aclosing, asynccontextmanager
from typing import Any

import httpx2
import pytest
from fastapi import FastAPI

from picloud_api.config import Settings
from picloud_api.llm.base import ChatMessage, ProviderSlot, StreamEvent, TextDelta, Usage
from picloud_api.main import create_app

AGENT_URL = "http://agent.test"

SNAPSHOT: dict[str, Any] = {
    "hostname": "picloud",
    "collected_at": "2026-10-02T12:00:00Z",
    "uptime_seconds": 86400.5,
    "platform": {
        "model": "Raspberry Pi 5 Model B Rev 1.0",
        "os": "Debian GNU/Linux 12 (bookworm)",
        "kernel": "6.6.51+rpt-rpi-2712",
        "arch": "arm64",
    },
    "cpu": {
        "cores": 4,
        "usage_percent": 12.3,
        "per_core_percent": [10.1, 14.0, 9.8, 15.2],
        "load_average": {"one": 0.42, "five": 0.35, "fifteen": 0.3},
        "temperature_celsius": 51.2,
        "frequency_mhz": 2400,
    },
    "memory": {
        "total_bytes": 8443211776,
        "available_bytes": 6000000000,
        "used_bytes": 2443211776,
        "usage_percent": 28.9,
        "swap_total_bytes": 536866816,
        "swap_used_bytes": 0,
    },
    "filesystems": [
        {
            "mountpoint": "/",
            "total_bytes": 62_000_000_000,
            "used_bytes": 27_900_000_000,
            "available_bytes": 31_000_000_000,
            "usage_percent": 45.0,
        }
    ],
    "network": [
        {
            "interface": "eth0",
            "rx_bytes_total": 1000,
            "tx_bytes_total": 2000,
            "rx_bytes_per_second": 10.5,
            "tx_bytes_per_second": 3.25,
        }
    ],
    "throttling": {
        "supported": True,
        "raw": "0x50000",
        "under_voltage_now": False,
        "frequency_capped_now": False,
        "throttled_now": False,
        "soft_temp_limit_now": False,
        "under_voltage_occurred": True,
        "frequency_capped_occurred": False,
        "throttled_occurred": True,
        "soft_temp_limit_occurred": False,
    },
}


def snapshot_data(**overrides: Any) -> dict[str, Any]:
    data = copy.deepcopy(SNAPSHOT)
    data.update(overrides)
    return data


@pytest.fixture(autouse=True)
def _isolated_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Settings must not pick up real keys or overrides from the developer's shell."""
    for name in list(os.environ):
        if name.startswith("PICLOUD_") or name in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY"):
            monkeypatch.delenv(name)


class FakeClock:
    def __init__(self, start: float = 1000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


Reply = Sequence[StreamEvent | Exception]
DEFAULT_USAGE = Usage(12, 34)


class FakeProvider:
    """Plays back scripted replies; the last reply repeats once the script runs out."""

    def __init__(
        self, name: str, replies: Sequence[Reply], *, local: bool = False, model: str = ""
    ) -> None:
        self.name = name
        self.local = local
        self.model = model or f"{name}-model"
        self._replies = list(replies)
        self.calls: list[dict[str, Any]] = []
        self.closed = False

    async def stream(
        self,
        messages: Sequence[ChatMessage],
        *,
        system: str,
        model: str | None,
        max_tokens: int,
        temperature: float | None,
    ) -> AsyncGenerator[StreamEvent, None]:
        self.calls.append(
            {
                "messages": list(messages),
                "system": system,
                "model": model,
                "max_tokens": max_tokens,
                "temperature": temperature,
            }
        )
        reply = self._replies.pop(0) if len(self._replies) > 1 else self._replies[0]
        for item in reply:
            if isinstance(item, Exception):
                raise item
            yield item

    async def aclose(self) -> None:
        self.closed = True


class HeldProvider(FakeProvider):
    """A FakeProvider that, while ``gate`` is set, holds each call until the gate opens.

    ``entered`` counts the calls that reached the provider; ``held`` is set once one waits.
    """

    def __init__(self, name: str, replies: Sequence[Reply]) -> None:
        super().__init__(name, replies)
        self.gate: asyncio.Event | None = None
        self.held = asyncio.Event()
        self.entered = 0

    async def stream(
        self,
        messages: Sequence[ChatMessage],
        *,
        system: str,
        model: str | None,
        max_tokens: int,
        temperature: float | None,
    ) -> AsyncGenerator[StreamEvent, None]:
        self.entered += 1
        if self.gate is not None:
            self.held.set()
            await self.gate.wait()
        reply = super().stream(
            messages, system=system, model=model, max_tokens=max_tokens, temperature=temperature
        )
        async with aclosing(reply):
            async for event in reply:
                yield event


def ok_reply(*chunks: str, usage: Usage | None = DEFAULT_USAGE) -> list[StreamEvent | Exception]:
    reply: list[StreamEvent | Exception] = [TextDelta(chunk) for chunk in chunks]
    if usage is not None:
        reply.append(usage)
    return reply


def slot(provider: FakeProvider | None, name: str = "", *, local: bool = False) -> ProviderSlot:
    if provider is None:
        return ProviderSlot(name, local=local, model=f"{name}-model", provider=None)
    return ProviderSlot(
        provider.name, local=provider.local, model=provider.model, provider=provider
    )


def make_settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {"agent_url": AGENT_URL, "ollama_url": "", "log_format": "console"}
    values.update(overrides)
    return Settings(**values)


@asynccontextmanager
async def serve(
    app: FastAPI, *, client_ip: str = "203.0.113.7"
) -> AsyncIterator[httpx2.AsyncClient]:
    """Run the app's lifespan and yield an HTTP client wired to it in-process."""
    async with app.router.lifespan_context(app):
        transport = httpx2.ASGITransport(app=app, client=(client_ip, 50000))
        async with httpx2.AsyncClient(transport=transport, base_url="http://testserver") as client:
            yield client


def build_app(providers: Sequence[ProviderSlot] = (), **settings_overrides: Any) -> FastAPI:
    return create_app(make_settings(**settings_overrides), provider_slots=providers)


def parse_sse(body: str) -> list[tuple[str, dict[str, Any]]]:
    """Split an SSE body into (event, data) pairs, skipping comments."""
    events: list[tuple[str, dict[str, Any]]] = []
    for block in body.split("\n\n"):
        if not block.strip() or block.startswith(":"):
            continue
        fields = dict(line.split(": ", 1) for line in block.splitlines())
        events.append((fields["event"], json.loads(fields["data"])))
    return events
