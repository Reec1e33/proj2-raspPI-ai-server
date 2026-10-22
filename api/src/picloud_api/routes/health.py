"""Liveness, readiness and Prometheus metrics."""

import time
from typing import Literal

from fastapi import APIRouter, Response
from pydantic import BaseModel

from picloud_api import __version__
from picloud_api.agent_client import AgentUnavailableError
from picloud_api.services import ServicesDep

router = APIRouter()


class HealthResponse(BaseModel):
    status: Literal["ok"]
    version: str
    uptime_seconds: float


class ReadyResponse(BaseModel):
    status: Literal["ready", "degraded"]
    checks: dict[str, str]


@router.get("/api/health", tags=["ops"])
async def health(services: ServicesDep) -> HealthResponse:
    """Liveness: the process is up and serving requests."""
    uptime = round(time.monotonic() - services.started_at, 1)
    return HealthResponse(status="ok", version=__version__, uptime_seconds=uptime)


@router.get(
    "/api/ready",
    tags=["ops"],
    responses={503: {"model": ReadyResponse, "description": "A dependency is unavailable"}},
)
async def ready(services: ServicesDep, response: Response) -> ReadyResponse:
    """Readiness: the agent answers and at least one LLM provider is enabled."""
    checks: dict[str, str] = {}
    try:
        await services.agent.snapshot()
        checks["agent"] = "ok"
    except AgentUnavailableError as exc:
        checks["agent"] = f"error: {exc}"
    checks["providers"] = "ok" if services.router.any_enabled else "none enabled"

    is_ready = all(value == "ok" for value in checks.values())
    if not is_ready:
        response.status_code = 503
    return ReadyResponse(status="ready" if is_ready else "degraded", checks=checks)


@router.get("/metrics", include_in_schema=False)
async def metrics(services: ServicesDep) -> Response:
    return Response(services.metrics.render(), media_type=services.metrics.content_type)
