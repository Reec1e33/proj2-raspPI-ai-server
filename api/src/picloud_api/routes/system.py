"""Host telemetry from the pi-agent: one snapshot, or a live SSE stream."""

import asyncio
import logging
from collections.abc import AsyncGenerator, Awaitable, Callable

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from picloud_api import sse
from picloud_api.agent_client import AgentClient, AgentUnavailableError, Snapshot
from picloud_api.services import ServicesDep

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/system", tags=["system"])


@router.get(
    "",
    responses={503: {"description": "The agent is unavailable"}},
)
async def get_system(services: ServicesDep) -> Snapshot:
    """The latest snapshot from the agent, validated against the agent contract."""
    try:
        return await services.agent.snapshot()
    except AgentUnavailableError as exc:
        logger.warning("agent unavailable", extra={"error": str(exc)})
        raise HTTPException(status_code=503, detail="agent unavailable") from exc


@router.get(
    "/stream",
    response_class=StreamingResponse,
    responses={200: {"content": {"text/event-stream": {}}}},
)
async def stream_system(services: ServicesDep) -> StreamingResponse:
    """``snapshot`` events every PICLOUD_STREAM_INTERVAL_S; ``error`` events while the agent
    is down (the stream stays open)."""
    events = snapshot_events(services.agent, services.settings.stream_interval_s)
    return StreamingResponse(
        sse.with_keepalive(events), media_type="text/event-stream", headers=sse.SSE_HEADERS
    )


async def snapshot_events(
    agent: AgentClient,
    interval_s: float,
    *,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> AsyncGenerator[str, None]:
    """Poll the agent forever; the response ends when the client disconnects."""
    while True:
        try:
            snapshot = await agent.snapshot()
        except AgentUnavailableError as exc:
            yield sse.format_event("error", {"detail": str(exc)})
        else:
            yield sse.format_event("snapshot", snapshot.model_dump(mode="json"))
        await sleep(interval_s)
