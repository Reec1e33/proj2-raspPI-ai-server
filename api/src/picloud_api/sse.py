"""Server-Sent Events helpers: event framing and keepalive pings."""

import asyncio
import json
from collections.abc import AsyncGenerator

# X-Accel-Buffering stops nginx from buffering the stream.
SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
KEEPALIVE_INTERVAL_S = 15.0
PING = ": ping\n\n"


def format_event(event: str, data: object) -> str:
    """Frame one SSE event. JSON never contains raw newlines, so one ``data:`` line suffices."""
    payload = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    return f"event: {event}\ndata: {payload}\n\n"


async def with_keepalive(
    source: AsyncGenerator[str, None], interval_s: float = KEEPALIVE_INTERVAL_S
) -> AsyncGenerator[str, None]:
    """Pass ``source`` through and add a ``: ping`` comment every ``interval_s`` seconds.

    The next item is awaited in a task so a slow source (a cold model load, say) is not
    cancelled when a ping is due.
    """
    loop = asyncio.get_running_loop()
    next_ping = loop.time() + interval_s
    pending: asyncio.Task[str | None] | None = None
    try:
        while True:
            if pending is None:
                pending = asyncio.create_task(_next_or_none(source))
            done, _ = await asyncio.wait({pending}, timeout=max(0.0, next_ping - loop.time()))
            if not done:
                yield PING
                next_ping += interval_s
                continue
            item = pending.result()
            pending = None
            if item is None:
                return
            yield item
    finally:
        if pending is not None:
            # Cancelling the in-flight read unwinds the source, closing it.
            pending.cancel()
        else:
            await source.aclose()


async def _next_or_none(source: AsyncGenerator[str, None]) -> str | None:
    try:
        return await anext(source)
    except StopAsyncIteration:
        return None
