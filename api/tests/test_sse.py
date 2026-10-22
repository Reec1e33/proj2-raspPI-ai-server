import asyncio
from collections.abc import AsyncGenerator

from picloud_api.sse import PING, format_event, with_keepalive


def test_format_event_is_one_compact_data_line() -> None:
    assert format_event("token", {"text": "Hel"}) == 'event: token\ndata: {"text":"Hel"}\n\n'


def test_format_event_escapes_newlines_and_keeps_unicode() -> None:
    framed = format_event("token", {"text": "line 1\nline 2 °C"})
    assert framed == 'event: token\ndata: {"text":"line 1\\nline 2 °C"}\n\n'


async def _items(*items: str, delay_s: float = 0.0) -> AsyncGenerator[str, None]:
    for item in items:
        await asyncio.sleep(delay_s)
        yield item


async def test_keepalive_passes_items_through() -> None:
    received = [item async for item in with_keepalive(_items("a", "b", "c"), interval_s=10)]
    assert received == ["a", "b", "c"]


async def test_keepalive_pings_while_the_source_is_slow() -> None:
    received = [item async for item in with_keepalive(_items("a", delay_s=0.12), interval_s=0.05)]
    assert received[-1] == "a"
    assert received.count(PING) >= 2
    assert set(received[:-1]) == {PING}


async def test_closing_early_closes_the_source() -> None:
    finished = asyncio.Event()

    async def source() -> AsyncGenerator[str, None]:
        try:
            yield "first"
            await asyncio.sleep(10)
            yield "never"
        finally:
            finished.set()

    stream = with_keepalive(source(), interval_s=0.01)
    assert await anext(stream) == "first"
    assert await anext(stream) == PING  # the slow read is now in flight
    await stream.aclose()
    await asyncio.wait_for(finished.wait(), timeout=1)


async def test_closing_between_items_closes_the_source() -> None:
    finished = asyncio.Event()

    async def source() -> AsyncGenerator[str, None]:
        try:
            yield "first"
            yield "second"
        finally:
            finished.set()

    stream = with_keepalive(source(), interval_s=10)
    assert await anext(stream) == "first"
    await stream.aclose()
    assert finished.is_set()
