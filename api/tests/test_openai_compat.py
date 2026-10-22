import json
from collections.abc import AsyncIterator

import httpx  # resolves to httpx2 (see tests/_alias_httpx.py); typed for respx
import pytest
import respx

from picloud_api.llm.base import (
    ChatMessage,
    ErrorReason,
    ProviderError,
    StreamEvent,
    TextDelta,
    Usage,
)
from picloud_api.llm.openai_compat import OpenAICompatProvider

BASE_URL = "https://api.groq.test/openai/v1"
URL = f"{BASE_URL}/chat/completions"
MESSAGES = [
    ChatMessage("user", "hello"),
    ChatMessage("assistant", "hi"),
    ChatMessage("user", "temp?"),
]


def chunk(choices: list[dict[str, object]], usage: dict[str, int] | None = None) -> str:
    body = {
        "id": "chatcmpl-1",
        "object": "chat.completion.chunk",
        "created": 1760000000,
        "model": "gpt-4o-mini",
        "choices": choices,
        "usage": usage,
    }
    return f"data: {json.dumps(body)}\n\n"


def delta(content: str | None, finish: str | None = None) -> dict[str, object]:
    return {"index": 0, "delta": {"content": content}, "finish_reason": finish}


SSE_BODY = (
    chunk([{"index": 0, "delta": {"role": "assistant", "content": ""}, "finish_reason": None}])
    + chunk([delta("Hel")])
    + chunk([delta("lo")])
    + chunk([delta(None, "stop")])
    + chunk([], usage={"prompt_tokens": 12, "completion_tokens": 34, "total_tokens": 46})
    + "data: [DONE]\n\n"
)


@pytest.fixture
async def provider() -> AsyncIterator[OpenAICompatProvider]:
    p = OpenAICompatProvider("sk-test", "gpt-4o-mini", base_url=BASE_URL, timeout_s=5)
    yield p
    await p.aclose()


async def collect(provider: OpenAICompatProvider, **kwargs: object) -> list[StreamEvent]:
    args: dict[str, object] = {
        "system": "sys",
        "model": None,
        "max_tokens": 64,
        "temperature": None,
    }
    args.update(kwargs)
    return [event async for event in provider.stream(MESSAGES, **args)]  # type: ignore[arg-type]


def sse_response(body: str) -> httpx.Response:
    return httpx.Response(200, text=body, headers={"content-type": "text/event-stream"})


@respx.mock
async def test_parses_chunks_including_the_usage_chunk(provider: OpenAICompatProvider) -> None:
    route = respx.post(URL).mock(return_value=sse_response(SSE_BODY))

    events = await collect(provider)

    assert events == [TextDelta("Hel"), TextDelta("lo"), Usage(12, 34)]
    request = route.calls.last.request
    assert request.headers["authorization"] == "Bearer sk-test"
    sent = json.loads(request.content)
    assert sent["model"] == "gpt-4o-mini"
    assert sent["stream"] is True
    assert sent["stream_options"] == {"include_usage": True}
    assert sent["max_completion_tokens"] == 64
    assert "temperature" not in sent
    assert sent["messages"] == [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "hi"},
        {"role": "user", "content": "temp?"},
    ]


@respx.mock
async def test_sends_temperature_and_model_override(provider: OpenAICompatProvider) -> None:
    route = respx.post(URL).mock(return_value=sse_response(SSE_BODY))
    await collect(provider, temperature=0.7, model="llama-3.1-8b-instant")
    sent = json.loads(route.calls.last.request.content)
    assert sent["temperature"] == 0.7
    assert sent["model"] == "llama-3.1-8b-instant"


@respx.mock
async def test_servers_without_usage_yield_text_only(provider: OpenAICompatProvider) -> None:
    respx.post(URL).mock(return_value=sse_response(chunk([delta("ok")]) + "data: [DONE]\n\n"))
    assert await collect(provider) == [TextDelta("ok")]


@pytest.mark.parametrize(
    ("status", "reason"),
    [
        (401, ErrorReason.UNAUTHORIZED),
        (404, ErrorReason.NOT_FOUND),
        (429, ErrorReason.RATE_LIMITED),
        (503, ErrorReason.SERVER_ERROR),
    ],
)
@respx.mock
async def test_status_errors(
    provider: OpenAICompatProvider, status: int, reason: ErrorReason
) -> None:
    respx.post(URL).respond(status, json={"error": {"message": "nope", "type": "x"}})
    with pytest.raises(ProviderError) as excinfo:
        await collect(provider)
    assert excinfo.value.reason is reason
    assert excinfo.value.status_code == status


@respx.mock
async def test_in_stream_error_is_a_server_error(provider: OpenAICompatProvider) -> None:
    error = {"error": {"message": "The server had an error", "type": "server_error"}}
    body = chunk([delta("par")]) + f"data: {json.dumps(error)}\n\n"
    respx.post(URL).mock(return_value=sse_response(body))

    received: list[StreamEvent] = []

    async def consume() -> None:
        stream = provider.stream(
            MESSAGES, system="sys", model=None, max_tokens=64, temperature=None
        )
        async for event in stream:
            received.append(event)

    with pytest.raises(ProviderError) as excinfo:
        await consume()

    assert received == [TextDelta("par")]
    assert excinfo.value.reason is ErrorReason.SERVER_ERROR


@pytest.mark.parametrize(
    ("exc", "reason"),
    [
        (httpx.ConnectError("refused"), ErrorReason.CONNECTION_ERROR),
        (httpx.ReadTimeout("slow"), ErrorReason.TIMEOUT),
    ],
)
@respx.mock
async def test_transport_errors(
    provider: OpenAICompatProvider, exc: Exception, reason: ErrorReason
) -> None:
    respx.post(URL).mock(side_effect=exc)
    with pytest.raises(ProviderError) as excinfo:
        await collect(provider)
    assert excinfo.value.reason is reason
