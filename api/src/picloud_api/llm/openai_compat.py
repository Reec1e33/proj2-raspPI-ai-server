"""OpenAI-compatible provider (OpenAI, Groq, vLLM, ...), using the official ``openai`` SDK."""

from collections.abc import AsyncGenerator, Sequence

import openai
from openai.types.chat import ChatCompletionMessageParam

from picloud_api.llm.base import (
    ChatMessage,
    ErrorReason,
    ProviderError,
    StreamEvent,
    TextDelta,
    Usage,
    reason_for_status,
)


class OpenAICompatProvider:
    name = "openai"
    local = False

    def __init__(self, api_key: str, model: str, *, base_url: str, timeout_s: float) -> None:
        self.model = model
        # The router owns retries (backoff + circuit breaker); SDK retries would multiply them.
        self._client = openai.AsyncOpenAI(
            api_key=api_key, base_url=base_url, timeout=timeout_s, max_retries=0
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
        params: list[ChatCompletionMessageParam] = [{"role": "system", "content": system}]
        for message in messages:
            if message.role == "user":
                params.append({"role": "user", "content": message.content})
            else:
                params.append({"role": "assistant", "content": message.content})
        usage: Usage | None = None
        try:
            stream = await self._client.chat.completions.create(
                model=model or self.model,
                messages=params,
                max_completion_tokens=max_tokens,
                temperature=openai.omit if temperature is None else temperature,
                stream=True,
                stream_options={"include_usage": True},
            )
            async with stream:
                async for chunk in stream:
                    # With include_usage the final chunk has empty choices and carries usage.
                    if chunk.usage is not None:
                        usage = Usage(chunk.usage.prompt_tokens, chunk.usage.completion_tokens)
                    for choice in chunk.choices:
                        if choice.delta.content:
                            yield TextDelta(choice.delta.content)
        except openai.APITimeoutError as exc:
            raise ProviderError(ErrorReason.TIMEOUT, "openai request timed out") from exc
        except openai.APIConnectionError as exc:
            raise ProviderError(ErrorReason.CONNECTION_ERROR, "openai connection failed") from exc
        except openai.APIStatusError as exc:
            raise ProviderError(
                reason_for_status(exc.status_code),
                f"openai returned HTTP {exc.status_code}",
                status_code=exc.status_code,
            ) from exc
        except openai.APIError as exc:  # an in-band error event inside an HTTP 200 stream
            raise ProviderError(ErrorReason.SERVER_ERROR, "openai stream sent an error") from exc
        if usage is not None:  # some compatible servers ignore include_usage
            yield usage

    async def aclose(self) -> None:
        await self._client.close()
