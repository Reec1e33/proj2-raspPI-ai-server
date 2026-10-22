"""Ordered provider fallback with retries, exponential backoff and per-provider circuit breakers.

Rules:
- Before the first token, transient errors are retried (up to ``max_retries``) and any
  failure falls through to the next provider in the chain.
- After the first token has been streamed, a failure ends the stream: the client has
  already shown partial output, so switching provider would splice two answers together.
"""

import asyncio
import logging
import random
import time
from collections.abc import AsyncGenerator, Awaitable, Callable, Sequence
from contextlib import aclosing
from dataclasses import dataclass
from enum import StrEnum

from picloud_api.llm.base import (
    ChatMessage,
    ErrorReason,
    ProviderError,
    ProviderSlot,
    TextDelta,
    Usage,
)
from picloud_api.metrics import Metrics

logger = logging.getLogger(__name__)

Clock = Callable[[], float]
Sleep = Callable[[float], Awaitable[None]]


class CircuitState(StrEnum):
    CLOSED = "closed"
    HALF_OPEN = "half_open"
    OPEN = "open"


_CIRCUIT_GAUGE_VALUE = {CircuitState.CLOSED: 0, CircuitState.HALF_OPEN: 1, CircuitState.OPEN: 2}

# `provider` label of picloud_chat_requests_total when no provider could be attempted.
NO_PROVIDER = "none"


@dataclass(eq=False, slots=True)
class Permit:
    """Leave to call a provider, from ``CircuitBreaker.acquire``. Compared by identity."""

    trial: bool  # True for the one half-open trial request


class CircuitBreaker:
    """Opens after ``failure_threshold`` consecutive failures; half-opens after ``cooldown_s``.

    Half-open lets exactly one trial request through. Until that trial ends, other requests
    skip the provider as if the circuit were open. A successful trial closes the circuit; a
    failed one opens it again for a fresh cooldown. A trial that ends without a verdict
    (cancelled because the client went away, or an error that does not count against the
    provider) frees the slot, and the next request becomes the trial.

    Callers ``acquire`` a permit before they call the provider and must ``release`` it however
    the call ends; a trial that never gave its slot back would skip the provider until restart.
    """

    def __init__(self, *, failure_threshold: int, cooldown_s: float, clock: Clock) -> None:
        self._threshold = failure_threshold
        self._cooldown_s = cooldown_s
        self._clock = clock
        self._failures = 0
        self._opened_at: float | None = None
        self._trial: Permit | None = None  # the half-open trial in flight, if any

    @property
    def state(self) -> CircuitState:
        """Closed, open or half-open; a trial in flight leaves the state half-open."""
        if self._opened_at is None:
            return CircuitState.CLOSED
        if self._clock() - self._opened_at >= self._cooldown_s:
            return CircuitState.HALF_OPEN
        return CircuitState.OPEN

    def acquire(self) -> Permit | None:
        """Return a permit to call the provider, or ``None`` if the request must skip it."""
        state = self.state
        if state is CircuitState.CLOSED:
            return Permit(trial=False)
        if state is CircuitState.HALF_OPEN and self._trial is None:
            self._trial = Permit(trial=True)
            return self._trial
        return None

    def allows(self, permit: Permit) -> bool:
        """Whether ``permit`` may still call the provider (checked again around each retry)."""
        state = self.state
        if state is CircuitState.CLOSED:
            return True
        return state is CircuitState.HALF_OPEN and permit is self._trial

    def release(self, permit: Permit) -> None:
        """Give back a permit when its call has ended, however it ended."""
        if permit is self._trial:
            self._trial = None

    def gauge_value(self) -> float:
        return _CIRCUIT_GAUGE_VALUE[self.state]

    def record_success(self) -> None:
        self._failures = 0
        self._opened_at = None

    def record_failure(self) -> None:
        self._failures += 1
        if self.state is CircuitState.HALF_OPEN or self._failures >= self._threshold:
            self._opened_at = self._clock()


@dataclass(frozen=True, slots=True)
class ChatSpec:
    messages: Sequence[ChatMessage]
    system: str
    max_tokens: int
    temperature: float | None = None
    provider: str | None = None  # pinned first provider
    model: str | None = None  # model override for the head of the chain


@dataclass(frozen=True, slots=True)
class Fallback:
    provider: str
    reason: str


@dataclass(frozen=True, slots=True)
class AttemptStarted:
    """The router started using a provider (emitted once per provider, not per retry)."""

    provider: str
    model: str


@dataclass(frozen=True, slots=True)
class Completed:
    provider: str
    model: str
    usage: Usage
    latency_ms: int
    ttft_ms: int | None
    fallbacks: tuple[Fallback, ...]


RouterEvent = AttemptStarted | TextDelta | Completed


class AllProvidersFailedError(Exception):
    def __init__(self, fallbacks: Sequence[Fallback]) -> None:
        summary = ", ".join(f"{f.provider} ({f.reason})" for f in fallbacks) or "none enabled"
        super().__init__(f"all providers failed: {summary}")
        self.fallbacks = tuple(fallbacks)


class StreamInterruptedError(Exception):
    def __init__(self, provider: str, reason: ErrorReason) -> None:
        super().__init__(f"{provider} failed after streaming had started ({reason})")
        self.provider = provider
        self.reason = reason


def _is_provider_fault(error: ProviderError, *, model_overridden: bool) -> bool:
    """Whether a failure counts toward the circuit breaker.

    A malformed request, or a model the caller named that does not exist, says nothing about
    the provider's health; counting it would let one client open the circuit for everyone.
    """
    if error.reason is ErrorReason.BAD_REQUEST:
        return False
    return not (model_overridden and error.reason is ErrorReason.NOT_FOUND)


class ProviderRouter:
    def __init__(
        self,
        slots: Sequence[ProviderSlot],
        *,
        metrics: Metrics,
        clock: Clock = time.monotonic,
        sleep: Sleep = asyncio.sleep,
        jitter: Callable[[], float] = random.random,
        max_retries: int = 2,
        base_delay_s: float = 0.5,
        failure_threshold: int = 3,
        cooldown_s: float = 30.0,
    ) -> None:
        self.slots = tuple(slots)
        self._by_name = {slot.name: slot for slot in self.slots}
        self._metrics = metrics
        self._clock = clock
        self._sleep = sleep
        self._jitter = jitter
        self._max_retries = max_retries
        self._base_delay_s = base_delay_s
        self._breakers: dict[str, CircuitBreaker] = {}
        for slot in self.slots:
            breaker = CircuitBreaker(
                failure_threshold=failure_threshold, cooldown_s=cooldown_s, clock=clock
            )
            self._breakers[slot.name] = breaker
            metrics.track_circuit(slot.name, breaker.gauge_value)

    @property
    def any_enabled(self) -> bool:
        return any(slot.enabled for slot in self.slots)

    def circuit_state(self, provider: str) -> CircuitState:
        return self._breakers[provider].state

    async def aclose(self) -> None:
        for slot in self.slots:
            if slot.provider is not None:
                await slot.provider.aclose()

    async def stream(self, spec: ChatSpec) -> AsyncGenerator[RouterEvent, None]:
        """Yield ``AttemptStarted`` per provider tried, then text deltas, then ``Completed``.

        Raises ``AllProvidersFailedError`` if no provider produced a reply and
        ``StreamInterruptedError`` if a provider failed after its first token.
        """
        started = self._clock()
        fallbacks: list[Fallback] = []
        attempted = False
        chain = self._chain(spec.provider)
        for name in chain:
            slot = self._by_name.get(name)
            if slot is None or slot.provider is None:
                if name == spec.provider:
                    self._fall_back(fallbacks, name, ErrorReason.DISABLED)
                continue
            breaker = self._breakers[name]
            permit = breaker.acquire()
            if permit is None:  # open, or half-open with its one trial already in flight
                self._fall_back(fallbacks, name, ErrorReason.CIRCUIT_OPEN)
                continue

            try:
                provider = slot.provider
                override = spec.model if spec.model and name == chain[0] else None
                model = override or provider.model
                attempted = True
                yield AttemptStarted(name, model)

                error: ProviderError | None = None
                for attempt in range(self._max_retries + 1):
                    if attempt and not await self._back_off(breaker, permit, attempt):
                        break
                    first_token_at: float | None = None
                    usage = Usage(0, 0)  # reported as zero when a provider omits usage
                    try:
                        events = provider.stream(
                            spec.messages,
                            system=spec.system,
                            model=model,
                            max_tokens=spec.max_tokens,
                            temperature=spec.temperature,
                        )
                        async with aclosing(events):
                            async for event in events:
                                if isinstance(event, Usage):
                                    usage = event
                                    continue
                                if first_token_at is None:
                                    first_token_at = self._clock()
                                yield event
                    except ProviderError as exc:
                        error = exc
                    except Exception as exc:  # a provider bug must fail over, not crash the request
                        logger.exception(
                            "provider raised an unexpected error", extra={"provider": name}
                        )
                        error = ProviderError(ErrorReason.INTERNAL_ERROR, type(exc).__name__)
                    else:
                        breaker.record_success()
                        yield self._complete(name, model, usage, started, first_token_at, fallbacks)
                        return

                    if _is_provider_fault(error, model_overridden=override is not None):
                        breaker.record_failure()
                    logger.warning(
                        "provider attempt failed",
                        extra={
                            "provider": name,
                            "attempt": attempt + 1,
                            "reason": error.reason.value,
                            "status_code": error.status_code,
                            "error": str(error),
                        },
                    )
                    if first_token_at is not None:
                        self._metrics.chat_requests.labels(name, "error").inc()
                        raise StreamInterruptedError(name, error.reason) from error
                    if not error.transient:
                        break

                self._metrics.chat_requests.labels(name, "error").inc()
                reason = error.reason if error is not None else ErrorReason.CIRCUIT_OPEN
                self._fall_back(fallbacks, name, reason)
            finally:
                # Runs on success, failure, cancellation and generator close (the client
                # went away), so a half-open trial always gives its slot back.
                breaker.release(permit)

        if not attempted:
            # No provider could even be tried (none enabled, or every circuit open). Count the
            # failed request anyway, so the chat error rate (and ChatErrorRateHigh) sees it.
            self._metrics.chat_requests.labels(NO_PROVIDER, "error").inc()
        logger.error(
            "all providers failed",
            extra={"fallbacks": [f"{f.provider}:{f.reason}" for f in fallbacks]},
        )
        raise AllProvidersFailedError(fallbacks)

    def _chain(self, pinned: str | None) -> list[str]:
        names = [slot.name for slot in self.slots]
        if pinned is None:
            return names
        return [pinned, *(name for name in names if name != pinned)]

    async def _back_off(self, breaker: CircuitBreaker, permit: Permit, attempt: int) -> bool:
        """Wait before a retry; return whether the circuit still lets ``permit`` call.

        Checked before the wait (a failed half-open trial must not retry, so do not wait for
        nothing) and again after it (other requests may have opened the circuit meanwhile).
        """
        if not breaker.allows(permit):
            return False
        delay = self._base_delay_s * 2.0 ** (attempt - 1)
        await self._sleep(delay + delay * self._jitter())
        return breaker.allows(permit)

    def _fall_back(self, fallbacks: list[Fallback], provider: str, reason: ErrorReason) -> None:
        fallbacks.append(Fallback(provider, reason.value))
        self._metrics.provider_fallbacks.labels(provider, reason.value).inc()

    def _complete(
        self,
        provider: str,
        model: str,
        usage: Usage,
        started: float,
        first_token_at: float | None,
        fallbacks: list[Fallback],
    ) -> Completed:
        now = self._clock()
        ttft_s = None if first_token_at is None else first_token_at - started
        metrics = self._metrics
        metrics.chat_requests.labels(provider, "success").inc()
        metrics.chat_tokens.labels(provider, "input").inc(usage.input_tokens)
        metrics.chat_tokens.labels(provider, "output").inc(usage.output_tokens)
        metrics.chat_duration.labels(provider).observe(now - started)
        if ttft_s is not None:
            metrics.chat_ttft.labels(provider).observe(ttft_s)
        done = Completed(
            provider=provider,
            model=model,
            usage=usage,
            latency_ms=round((now - started) * 1000),
            ttft_ms=None if ttft_s is None else round(ttft_s * 1000),
            fallbacks=tuple(fallbacks),
        )
        logger.info(
            "chat completed",
            extra={
                "provider": provider,
                "model": model,
                "latency_ms": done.latency_ms,
                "ttft_ms": done.ttft_ms,
                "input_tokens": usage.input_tokens,
                "output_tokens": usage.output_tokens,
                "fallbacks": [f.provider for f in fallbacks],
            },
        )
        return done
