"""Provider-neutral types for streaming chat completions."""

from collections.abc import AsyncGenerator, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Literal, Protocol


@dataclass(frozen=True, slots=True)
class ChatMessage:
    role: Literal["user", "assistant"]
    content: str


@dataclass(frozen=True, slots=True)
class TextDelta:
    """A chunk of generated text."""

    text: str


@dataclass(frozen=True, slots=True)
class Usage:
    """Token counts; providers yield it once, after the last text delta."""

    input_tokens: int
    output_tokens: int


StreamEvent = TextDelta | Usage


class ErrorReason(StrEnum):
    """Reason codes reported in ``fallbacks`` and metrics."""

    TIMEOUT = "timeout"
    CONNECTION_ERROR = "connection_error"
    RATE_LIMITED = "rate_limited"
    SERVER_ERROR = "server_error"
    UNAUTHORIZED = "unauthorized"
    NOT_FOUND = "not_found"
    BAD_REQUEST = "bad_request"
    BAD_RESPONSE = "bad_response"
    INTERNAL_ERROR = "internal_error"
    CIRCUIT_OPEN = "circuit_open"
    DISABLED = "disabled"


TRANSIENT_REASONS = frozenset(
    {
        ErrorReason.TIMEOUT,
        ErrorReason.CONNECTION_ERROR,
        ErrorReason.RATE_LIMITED,
        ErrorReason.SERVER_ERROR,
    }
)


class ProviderError(Exception):
    """A provider call failed. Transient errors are retried; permanent ones are not."""

    def __init__(self, reason: ErrorReason, message: str, *, status_code: int | None = None):
        super().__init__(message)
        self.reason = reason
        self.status_code = status_code

    @property
    def transient(self) -> bool:
        return self.reason in TRANSIENT_REASONS


def reason_for_status(status: int) -> ErrorReason:
    """Map an upstream HTTP status to a reason code."""
    if status in (401, 403):
        return ErrorReason.UNAUTHORIZED
    if status == 404:
        return ErrorReason.NOT_FOUND
    if status == 408:
        return ErrorReason.TIMEOUT
    if status == 429:
        return ErrorReason.RATE_LIMITED
    if 400 <= status < 500:
        return ErrorReason.BAD_REQUEST
    # 5xx, and SDK errors raised from an in-band stream error event (HTTP 200).
    return ErrorReason.SERVER_ERROR


class Provider(Protocol):
    """A chat backend that streams text deltas and then one ``Usage`` event."""

    name: str
    local: bool
    model: str

    def stream(
        self,
        messages: Sequence[ChatMessage],
        *,
        system: str,
        model: str | None,
        max_tokens: int,
        temperature: float | None,
    ) -> AsyncGenerator[StreamEvent, None]:
        """Stream a completion. ``model=None`` uses the provider's configured model.

        Raises ``ProviderError`` for every expected failure.
        """
        ...

    async def aclose(self) -> None: ...


@dataclass(frozen=True, slots=True)
class ProviderSlot:
    """A provider position in the fallback chain. ``provider`` is None when it is disabled."""

    name: str
    local: bool
    model: str
    provider: Provider | None

    @property
    def enabled(self) -> bool:
        return self.provider is not None
