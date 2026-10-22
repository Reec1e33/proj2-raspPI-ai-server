"""Anthropic provider, using the official SDK's async streaming helper."""

from collections.abc import AsyncGenerator, Sequence

import anthropic
from anthropic.types import MessageParam

from picloud_api.llm.base import (
    ChatMessage,
    ErrorReason,
    ProviderError,
    StreamEvent,
    TextDelta,
    Usage,
    reason_for_status,
)


class AnthropicProvider:
    name = "anthropic"
    local = False

    def __init__(self, api_key: str, model: str, *, timeout_s: float) -> None:
        self.model = model
        # The router owns retries (backoff + circuit breaker); SDK retries would multiply them.
        self._client = anthropic.AsyncAnthropic(api_key=api_key, timeout=timeout_s, max_retries=0)

    async def stream(
        self,
        messages: Sequence[ChatMessage],
        *,
        system: str,
        model: str | None,
        max_tokens: int,
        temperature: float | None,
    ) -> AsyncGenerator[StreamEvent, None]:
        params: list[MessageParam] = [{"role": m.role, "content": m.content} for m in messages]
        # anthropic 1.x removed sampling parameters from the typed signature. Models that still
        # accept temperature (such as claude-haiku-4-5) take it through extra_body; newer models
        # reject it with HTTP 400, which the router treats as a permanent error.
        extra_body = {"temperature": temperature} if temperature is not None else None
        try:
            async with self._client.messages.stream(
                model=model or self.model,
                max_tokens=max_tokens,
                system=system,
                messages=params,
                extra_body=extra_body,
            ) as stream:
                async for text in stream.text_stream:
                    if text:
                        yield TextDelta(text)
                final = await stream.get_final_message()
        except anthropic.APITimeoutError as exc:
            raise ProviderError(ErrorReason.TIMEOUT, "anthropic request timed out") from exc
        except anthropic.APIConnectionError as exc:
            raise ProviderError(
                ErrorReason.CONNECTION_ERROR, "anthropic connection failed"
            ) from exc
        except anthropic.APIStatusError as exc:
            raise ProviderError(
                reason_for_status(exc.status_code),
                f"anthropic returned HTTP {exc.status_code} ({exc.type or 'unknown error'})",
                status_code=exc.status_code,
            ) from exc
        yield Usage(final.usage.input_tokens, final.usage.output_tokens)

    async def aclose(self) -> None:
        await self._client.close()
