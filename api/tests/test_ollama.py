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
from picloud_api.llm.ollama import OllamaProvider

URL = "http://ollama.test/api/chat"
MESSAGES = [ChatMessage("user", "Why is my Pi hot?")]


def ndjson(*chunks: dict[str, object]) -> str:
    return "".join(json.dumps(chunk) + "\n" for chunk in chunks)


@pytest.fixture
async def provider() -> AsyncIterator[OllamaProvider]:
    p = OllamaProvider("http://ollama.test", "llama3.2:1b", timeout_s=5)
    yield p
    await p.aclose()


async def collect(provider: OllamaProvider, **kwargs: object) -> list[StreamEvent]:
    args: dict[str, object] = {
        "system": "sys",
        "model": None,
        "max_tokens": 64,
        "temperature": None,
    }
    args.update(kwargs)
    return [event async for event in provider.stream(MESSAGES, **args)]  # type: ignore[arg-type]


@respx.mock
async def test_parses_ndjson_stream(provider: OllamaProvider) -> None:
    route = respx.post(URL).respond(
        200,
        text=ndjson(
            {
                "model": "llama3.2:1b",
                "message": {"role": "assistant", "content": "Hel"},
                "done": False,
            },
            {
                "model": "llama3.2:1b",
                "message": {"role": "assistant", "content": ""},
                "done": False,
            },
            {
                "model": "llama3.2:1b",
                "message": {"role": "assistant", "content": "lo"},
                "done": False,
            },
            {"done": True, "done_reason": "stop", "prompt_eval_count": 12, "eval_count": 34},
        )
        + "\n",
    )

    events = await collect(provider, temperature=0.2)

    assert events == [TextDelta("Hel"), TextDelta("lo"), Usage(12, 34)]
    sent = json.loads(route.calls.last.request.content)
    assert sent == {
        "model": "llama3.2:1b",
        "messages": [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "Why is my Pi hot?"},
        ],
        "stream": True,
        "options": {"num_predict": 64, "temperature": 0.2},
    }


@respx.mock
async def test_model_override_and_no_temperature(provider: OllamaProvider) -> None:
    route = respx.post(URL).respond(200, text=ndjson({"done": True}))
    events = await collect(provider, model="qwen2.5:0.5b")
    assert events == [Usage(0, 0)]
    sent = json.loads(route.calls.last.request.content)
    assert sent["model"] == "qwen2.5:0.5b"
    assert sent["options"] == {"num_predict": 64}


@pytest.mark.parametrize(
    ("status", "reason"),
    [
        (404, ErrorReason.NOT_FOUND),
        (400, ErrorReason.BAD_REQUEST),
        (500, ErrorReason.SERVER_ERROR),
        (503, ErrorReason.SERVER_ERROR),
    ],
)
@respx.mock
async def test_http_errors_are_classified(
    provider: OllamaProvider, status: int, reason: ErrorReason
) -> None:
    respx.post(URL).respond(status, json={"error": 'model "llama3.2:1b" not found'})
    with pytest.raises(ProviderError) as excinfo:
        await collect(provider)
    assert excinfo.value.reason is reason
    assert excinfo.value.status_code == status
    assert "not found" in str(excinfo.value)


@respx.mock
async def test_non_json_error_body(provider: OllamaProvider) -> None:
    respx.post(URL).respond(502, text="bad gateway")
    with pytest.raises(ProviderError, match="bad gateway"):
        await collect(provider)


@respx.mock
async def test_in_stream_error(provider: OllamaProvider) -> None:
    respx.post(URL).respond(200, text=ndjson({"error": "out of memory"}))
    with pytest.raises(ProviderError, match="out of memory") as excinfo:
        await collect(provider)
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
    provider: OllamaProvider, exc: Exception, reason: ErrorReason
) -> None:
    respx.post(URL).mock(side_effect=exc)
    with pytest.raises(ProviderError) as excinfo:
        await collect(provider)
    assert excinfo.value.reason is reason
    assert excinfo.value.transient


@pytest.mark.parametrize("body", ["not json\n", "[1, 2]\n", ndjson({"message": {"content": "x"}})])
@respx.mock
async def test_malformed_streams(provider: OllamaProvider, body: str) -> None:
    respx.post(URL).respond(200, text=body)
    with pytest.raises(ProviderError) as excinfo:
        await collect(provider)
    assert excinfo.value.reason is ErrorReason.BAD_RESPONSE
    assert not excinfo.value.transient
