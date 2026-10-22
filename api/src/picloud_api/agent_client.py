"""Client for the pi-agent telemetry service, with a typed snapshot model and a short cache."""

import asyncio
import time
from collections.abc import Callable
from datetime import datetime

import httpx2
from pydantic import BaseModel, ConfigDict, ValidationError

# --- Snapshot model: mirrors GET /v1/snapshot of the agent contract. Nullable keys are required.


class _Model(BaseModel):
    model_config = ConfigDict(frozen=True, extra="ignore")


class Platform(_Model):
    model: str | None
    os: str | None
    kernel: str | None
    arch: str


class LoadAverage(_Model):
    one: float
    five: float
    fifteen: float


class Cpu(_Model):
    cores: int
    usage_percent: float
    per_core_percent: list[float]
    load_average: LoadAverage
    temperature_celsius: float | None
    frequency_mhz: float | None


class Memory(_Model):
    total_bytes: int
    available_bytes: int
    used_bytes: int
    usage_percent: float
    swap_total_bytes: int
    swap_used_bytes: int


class Filesystem(_Model):
    mountpoint: str
    total_bytes: int
    used_bytes: int
    available_bytes: int
    usage_percent: float


class NetworkInterface(_Model):
    interface: str
    rx_bytes_total: int
    tx_bytes_total: int
    rx_bytes_per_second: float
    tx_bytes_per_second: float


class Throttling(_Model):
    supported: bool
    raw: str | None
    under_voltage_now: bool
    frequency_capped_now: bool
    throttled_now: bool
    soft_temp_limit_now: bool
    under_voltage_occurred: bool
    frequency_capped_occurred: bool
    throttled_occurred: bool
    soft_temp_limit_occurred: bool


class Snapshot(_Model):
    hostname: str
    collected_at: datetime
    uptime_seconds: float
    platform: Platform
    cpu: Cpu
    memory: Memory
    filesystems: list[Filesystem]
    network: list[NetworkInterface]
    throttling: Throttling


class AgentUnavailableError(Exception):
    """The agent could not be reached or returned an invalid snapshot."""


class AgentClient:
    """Fetches snapshots from the agent.

    Results (and failures) are cached for ``cache_ttl_s`` and concurrent callers share one
    upstream request, so many SSE clients cost the agent one request per TTL.
    """

    def __init__(
        self,
        base_url: str,
        *,
        timeout_s: float = 2.0,
        cache_ttl_s: float = 1.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._http = httpx2.AsyncClient(base_url=base_url, timeout=timeout_s)
        self._cache_ttl_s = cache_ttl_s
        self._clock = clock
        self._lock = asyncio.Lock()
        self._cached: tuple[float, Snapshot | str] | None = None  # (fetched_at, snapshot | error)

    async def snapshot(self) -> Snapshot:
        async with self._lock:
            if self._cached is None or self._clock() - self._cached[0] >= self._cache_ttl_s:
                result: Snapshot | str
                try:
                    result = await self._fetch()
                except AgentUnavailableError as exc:
                    result = str(exc)
                # Stamp after the fetch so a slow failure still shields waiters for a full TTL.
                self._cached = (self._clock(), result)
            cached = self._cached[1]
        if isinstance(cached, str):
            raise AgentUnavailableError(cached)
        return cached

    async def _fetch(self) -> Snapshot:
        try:
            response = await self._http.get("/v1/snapshot")
            response.raise_for_status()
            return Snapshot.model_validate_json(response.content)
        except httpx2.HTTPStatusError as exc:
            status = exc.response.status_code
            raise AgentUnavailableError(f"agent returned HTTP {status}") from exc
        except httpx2.HTTPError as exc:
            raise AgentUnavailableError(f"agent request failed ({type(exc).__name__})") from exc
        except ValidationError as exc:
            count = exc.error_count()
            raise AgentUnavailableError(f"agent sent an invalid snapshot ({count} errors)") from exc

    async def aclose(self) -> None:
        await self._http.aclose()
