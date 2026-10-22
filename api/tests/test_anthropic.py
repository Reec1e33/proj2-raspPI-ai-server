"""Anthropic provider against recorded-shape SSE responses served through respx."""

import json
from collections.abc import AsyncIterator

import httpx  # resolves to httpx2 (see tests/_alias_httpx.py); typed for respx
import pytest
import respx

from picloud_api.llm.anthropic import AnthropicProvider
from picloud_api.llm.base import (
    ChatMessage,
    ErrorReason,
    ProviderError,
    StreamEvent,
    TextDelta,
    Usage,
)

URL = "https://api.anthropic.com/v1/messages"
MESSAGES = [ChatMessage("user", "Why is my Pi slow?")]


def event(name: str, data: dict[str, object]) -> str:
    return f"event: {name}\ndata: {json.dumps(data)}\n\n"


def text_delta(text: str) -> str:
    return event(
        "content_block_delta",
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}},
    )


MESSAGE_START = event(
    "message_start",
    {
        "type": "message_start",
        "message": {
            "id": "msg_01",
            "type": "message",
            "role": "assistant",
            "model": "claude-haiku-4-5",
            "content": [],
            "stop_reason": None,
            "stop_sequence": None,
            "usage": {"input_tokens": 12, "output_tokens": 1},
        },
    },
)
BLOCK_START = event(
    "content_block_start",
    {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
)
MESSAGE_END = (
    event("content_block_stop", {"type": "content_block_stop", "index": 0})
    + event(
        "message_delta",
        {
            "type": "message_delta",
            "delta": {"stop_reason": "end_turn", "stop_sequence": None},
            "usage": {"output_tokens": 34},
        },
    )
    + event("message_stop", {"type": "message_stop"})
)


def sse_response(body: str) -> httpx.Response:
    return httpx.Response(200, text=body, headers={"content-type": "text/event-stream"})


@pytest.fixture
async def provider() -> AsyncIterator[AnthropicProvider]:
    p = AnthropicProvider("sk-ant-test", "claude-haiku-4-5", timeout_s=5)
    yield p
    await p.aclose()


async def collect(provider: AnthropicProvider, **kwargs: object) -> list[StreamEvent]:
    args: dict[str, object] = {
        "system": "sys",
        "model": None,
        "max_tokens": 64,
        "temperature": None,
    }
    args.update(kwargs)
    return [event async for event in provider.stream(MESSAGES, **args)]  # type: ignore[arg-type]


@respx.mock
async def test_streams_text_and_final_usage(provider: AnthropicProvider) -> None:
    body = MESSAGE_START + BLOCK_START + text_delta("Hel") + text_delta("lo") + MESSAGE_END
    route = respx.post(URL).mock(return_value=sse_response(body))

    events = await collect(provider)

    assert events == [TextDelta("Hel"), TextDelta("lo"), Usage(12, 34)]
    request = route.calls.last.request
    assert request.headers["x-api-key"] == "sk-ant-test"
    sent = json.loads(request.content)
    assert sent["model"] == "claude-haiku-4-5"
    assert sent["max_tokens"] == 64
    assert sent["system"] == "sys"
    assert sent["stream"] is True
    assert sent["messages"] == [{"role": "user", "content": "Why is my Pi slow?"}]
    assert "temperature" not in sent


@respx.mock
async def test_temperature_and_model_override_reach_the_api(provider: AnthropicProvider) -> None:
    route = respx.post(URL).mock(
        return_value=sse_response(MESSAGE_START + BLOCK_START + MESSAGE_END)
    )
    await collect(provider, temperature=0.4, model="claude-sonnet-5-5")
    sent = json.loads(route.calls.last.request.content)
    assert sent["temperature"] == 0.4
    assert sent["model"] == "claude-sonnet-5-5"


@pytest.mark.parametrize(
    ("status", "error_type", "reason"),
    [
        (401, "authentication_error", ErrorReason.UNAUTHORIZED),
        (404, "not_found_error", ErrorReason.NOT_FOUND),
        (400, "invalid_request_error", ErrorReason.BAD_REQUEST),
        (429, "rate_limit_error", ErrorReason.RATE_LIMITED),
        (529, "overloaded_error", ErrorReason.SERVER_ERROR),
    ],
)
@respx.mock
async def test_status_errors(
    provider: AnthropicProvider, status: int, error_type: str, reason: ErrorReason
) -> None:
    respx.post(URL).respond(
        status, json={"type": "error", "error": {"type": error_type, "message": "nope"}}
    )
    with pytest.raises(ProviderError) as excinfo:
        await collect(provider)
    assert excinfo.value.reason is reason
    assert excinfo.value.status_code == status
    assert error_type in str(excinfo.value)


@respx.mock
async def test_in_stream_error_event_is_a_server_error(provider: AnthropicProvider) -> None:
    body = (
        MESSAGE_START
        + BLOCK_START
        + event("error", {"type": "error", "error": {"type": "overloaded_error", "message": "x"}})
    )
    respx.post(URL).mock(return_value=sse_response(body))
    with pytest.raises(ProviderError) as excinfo:
        await collect(provider)
    assert excinfo.value.reason is ErrorReason.SERVER_ERROR
    assert excinfo.value.transient


@pytest.mark.parametrize(
    ("exc", "reason"),
    [
        (httpx.ConnectError("refused"), ErrorReason.CONNECTION_ERROR),
        (httpx.ReadTimeout("slow"), ErrorReason.TIMEOUT),
    ],
)
@respx.mock
async def test_transport_errors(
    provider: AnthropicProvider, exc: Exception, reason: ErrorReason
) -> None:
    respx.post(URL).mock(side_effect=exc)
    with pytest.raises(ProviderError) as excinfo:
        await collect(provider)
    assert excinfo.value.reason is reason
