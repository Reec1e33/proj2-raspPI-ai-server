"""Ollama provider: ``POST /api/chat`` with newline-delimited JSON streaming."""

import json
from collections.abc import AsyncGenerator, Sequence
from typing import Any

import httpx2

from picloud_api.llm.base import (
    ChatMessage,
    ErrorReason,
    ProviderError,
    StreamEvent,
    TextDelta,
    Usage,
    reason_for_status,
)


class OllamaProvider:
    name = "ollama"
    local = True

    def __init__(self, base_url: str, model: str, *, timeout_s: float) -> None:
        self.model = model
        # The read timeout bounds the gap between chunks, which covers a cold model load on a Pi.
        self._http = httpx2.AsyncClient(
            base_url=base_url, timeout=httpx2.Timeout(timeout_s, connect=5.0)
        )

    async def stream(
        self,
        messages: Sequence[ChatMessage],
        *,
        system: str,
        model: str | None,
        max_tokens: int,
        temperature: float | None,
    ) -> AsyncGenerator[StreamEvent, None]:
        options: dict[str, Any] = {"num_predict": max_tokens}
        if temperature is not None:
            options["temperature"] = temperature
        payload = {
            "model": model or self.model,
            "messages": [
                {"role": "system", "content": system},
                *({"role": m.role, "content": m.content} for m in messages),
            ],
            "stream": True,
            "options": options,
        }
        try:
            async with self._http.stream("POST", "/api/chat", json=payload) as response:
                if response.is_error:
                    await response.aread()
                    raise ProviderError(
                        reason_for_status(response.status_code),
                        f"ollama returned HTTP {response.status_code}: {_error_text(response)}",
                        status_code=response.status_code,
                    )
                async for line in response.aiter_lines():
                    if not line.strip():
                        continue
                    chunk = _parse_line(line)
                    if "error" in chunk:
                        raise ProviderError(ErrorReason.SERVER_ERROR, f"ollama: {chunk['error']}")
                    text = chunk.get("message", {}).get("content")
                    if text:
                        yield TextDelta(text)
                    if chunk.get("done"):
                        yield Usage(
                            input_tokens=int(chunk.get("prompt_eval_count", 0)),
                            output_tokens=int(chunk.get("eval_count", 0)),
                        )
                        return
        except httpx2.TimeoutException as exc:
            raise ProviderError(ErrorReason.TIMEOUT, "ollama request timed out") from exc
        except httpx2.RequestError as exc:
            raise ProviderError(
                ErrorReason.CONNECTION_ERROR, f"ollama request failed: {type(exc).__name__}"
            ) from exc
        raise ProviderError(ErrorReason.BAD_RESPONSE, "ollama stream ended before done")

    async def aclose(self) -> None:
        await self._http.aclose()


def _parse_line(line: str) -> dict[str, Any]:
    try:
        chunk = json.loads(line)
    except json.JSONDecodeError as exc:
        raise ProviderError(ErrorReason.BAD_RESPONSE, "ollama sent invalid JSON") from exc
    if not isinstance(chunk, dict):
        raise ProviderError(ErrorReason.BAD_RESPONSE, "ollama sent a non-object chunk")
    return chunk


def _error_text(response: httpx2.Response) -> str:
    try:
        return str(response.json()["error"])
    except (ValueError, KeyError, TypeError):
        return response.text[:200]
