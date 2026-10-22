import asyncio
from collections.abc import AsyncGenerator, Sequence
from contextlib import suppress

import pytest

from picloud_api.llm.base import (
    ChatMessage,
    ErrorReason,
    ProviderError,
    ProviderSlot,
    StreamEvent,
    TextDelta,
    Usage,
)
from picloud_api.llm.router import (
    AllProvidersFailedError,
    AttemptStarted,
    ChatSpec,
    CircuitBreaker,
    CircuitState,
    Completed,
    Fallback,
    ProviderRouter,
    RouterEvent,
    StreamInterruptedError,
)
from picloud_api.metrics import Metrics
from tests.conftest import FakeClock, FakeProvider, HeldProvider, Reply, ok_reply, slot

SPEC = ChatSpec(messages=(ChatMessage("user", "hi"),), system="sys", max_tokens=64)
CIRCUIT_GAUGE = "picloud_provider_circuit_state"
GUARD_S = 1.0  # a regression in the concurrency tests fails after this instead of hanging


def unauthorized() -> ProviderError:
    return ProviderError(ErrorReason.UNAUTHORIZED, "bad key", status_code=401)


def timeout() -> ProviderError:
    return ProviderError(ErrorReason.TIMEOUT, "timed out")


class Harness:
    def __init__(self, slots: Sequence[ProviderSlot]) -> None:
        self.clock = FakeClock()
        self.sleeps: list[float] = []
        self.metrics = Metrics("test")
        self.router = ProviderRouter(
            slots,
            metrics=self.metrics,
            clock=self.clock,
            sleep=self._sleep,
            jitter=lambda: 0.0,
        )

    async def _sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.clock.advance(seconds)

    async def run(self, spec: ChatSpec = SPEC) -> list[RouterEvent]:
        return [event async for event in self.router.stream(spec)]

    def sample(self, name: str, **labels: str) -> float | None:
        return self.metrics.registry.get_sample_value(name, labels)


async def test_streams_tokens_then_completed() -> None:
    ollama = FakeProvider("ollama", [ok_reply("Hel", "lo")], local=True)
    h = Harness([slot(ollama)])

    events = await h.run()

    assert events[:3] == [
        AttemptStarted("ollama", "ollama-model"),
        TextDelta("Hel"),
        TextDelta("lo"),
    ]
    done = events[-1]
    assert isinstance(done, Completed)
    assert done.usage == Usage(12, 34)
    assert done.fallbacks == ()
    assert h.sample("picloud_chat_requests_total", provider="ollama", outcome="success") == 1
    assert h.sample("picloud_chat_tokens_total", provider="ollama", direction="output") == 34
    assert ollama.calls[0]["model"] == "ollama-model"
    assert ollama.calls[0]["system"] == "sys"


class TimedProvider(FakeProvider):
    """Advances the clock 0.2 s before the first token and 0.3 s after it."""

    def __init__(self, clock: FakeClock) -> None:
        super().__init__("ollama", [[]])
        self._clock = clock

    async def stream(
        self,
        messages: Sequence[ChatMessage],
        *,
        system: str,
        model: str | None,
        max_tokens: int,
        temperature: float | None,
    ) -> AsyncGenerator[StreamEvent, None]:
        self._clock.advance(0.2)
        yield TextDelta("a")
        self._clock.advance(0.3)
        yield Usage(1, 1)


async def test_latency_and_ttft_come_from_the_clock() -> None:
    h = Harness([])
    h.router = ProviderRouter([slot(TimedProvider(h.clock))], metrics=h.metrics, clock=h.clock)

    done = (await h.run())[-1]

    assert isinstance(done, Completed)
    assert (done.ttft_ms, done.latency_ms) == (200, 500)
    assert h.sample("picloud_chat_ttft_seconds_count", provider="ollama") == 1
    assert h.sample("picloud_chat_duration_seconds_sum", provider="ollama") == pytest.approx(0.5)


async def test_missing_usage_is_reported_as_zero() -> None:
    h = Harness([slot(FakeProvider("openai", [ok_reply("x", usage=None)]))])
    done = (await h.run())[-1]
    assert isinstance(done, Completed)
    assert done.usage == Usage(0, 0)


async def test_falls_back_before_the_first_token() -> None:
    ollama = FakeProvider("ollama", [[unauthorized()]])
    claude = FakeProvider("anthropic", [ok_reply("ok")])
    h = Harness([slot(ollama), slot(claude)])

    events = await h.run()

    assert events[0] == AttemptStarted("ollama", "ollama-model")
    assert events[1] == AttemptStarted("anthropic", "anthropic-model")
    assert events[2] == TextDelta("ok")
    done = events[-1]
    assert isinstance(done, Completed)
    assert done.provider == "anthropic"
    assert done.fallbacks == (Fallback("ollama", "unauthorized"),)
    assert (
        h.sample("picloud_provider_fallbacks_total", provider="ollama", reason="unauthorized") == 1
    )
    assert h.sample("picloud_chat_requests_total", provider="ollama", outcome="error") == 1


async def test_never_falls_back_after_the_first_token() -> None:
    ollama = FakeProvider("ollama", [[TextDelta("par"), timeout()]])
    claude = FakeProvider("anthropic", [ok_reply("ok")])
    h = Harness([slot(ollama), slot(claude)])

    received: list[RouterEvent] = []

    async def consume() -> None:
        async for event in h.router.stream(SPEC):
            received.append(event)

    with pytest.raises(StreamInterruptedError) as excinfo:
        await consume()

    assert received == [AttemptStarted("ollama", "ollama-model"), TextDelta("par")]
    assert excinfo.value.provider == "ollama"
    assert excinfo.value.reason is ErrorReason.TIMEOUT
    assert len(ollama.calls) == 1  # not retried either
    assert claude.calls == []


async def test_retries_transient_errors_with_backoff() -> None:
    ollama = FakeProvider("ollama", [[timeout()], [timeout()], ok_reply("ok")])
    h = Harness([slot(ollama)])

    events = await h.run()

    assert len(ollama.calls) == 3
    assert h.sleeps == [0.5, 1.0]
    assert [e for e in events if isinstance(e, AttemptStarted)] == [
        AttemptStarted("ollama", "ollama-model")
    ]
    assert isinstance(events[-1], Completed)
    assert events[-1].fallbacks == ()


async def test_backoff_adds_jitter() -> None:
    ollama = FakeProvider("ollama", [[timeout()], ok_reply("ok")])
    h = Harness([slot(ollama)])
    h.router = ProviderRouter(
        [slot(ollama)], metrics=h.metrics, clock=h.clock, sleep=h._sleep, jitter=lambda: 0.5
    )
    await h.run()
    assert h.sleeps == [0.75]


async def test_gives_up_after_max_retries_then_falls_back() -> None:
    ollama = FakeProvider("ollama", [[ProviderError(ErrorReason.SERVER_ERROR, "boom")]])
    claude = FakeProvider("anthropic", [ok_reply("ok")])
    h = Harness([slot(ollama), slot(claude)])

    done = (await h.run())[-1]

    assert len(ollama.calls) == 3  # 1 attempt + 2 retries
    assert isinstance(done, Completed)
    assert done.fallbacks == (Fallback("ollama", "server_error"),)


async def test_does_not_retry_auth_errors() -> None:
    claude = FakeProvider("anthropic", [[unauthorized()]])
    openai = FakeProvider("openai", [ok_reply("ok")])
    h = Harness([slot(claude), slot(openai)])

    await h.run()

    assert len(claude.calls) == 1
    assert h.sleeps == []


async def test_all_providers_failed() -> None:
    ollama = FakeProvider("ollama", [[unauthorized()]])
    claude = FakeProvider("anthropic", [[ProviderError(ErrorReason.NOT_FOUND, "no model")]])
    h = Harness([slot(ollama), slot(claude)])

    with pytest.raises(AllProvidersFailedError) as excinfo:
        await h.run()

    assert excinfo.value.fallbacks == (
        Fallback("ollama", "unauthorized"),
        Fallback("anthropic", "not_found"),
    )
    assert "ollama (unauthorized)" in str(excinfo.value)


async def test_no_enabled_providers() -> None:
    h = Harness([slot(None, "ollama", local=True), slot(None, "openai")])
    assert not h.router.any_enabled
    with pytest.raises(AllProvidersFailedError, match="none enabled") as excinfo:
        await h.run()
    assert excinfo.value.fallbacks == ()
    assert h.sample("picloud_chat_requests_total", provider="none", outcome="error") == 1


async def test_request_that_no_provider_could_attempt_is_counted() -> None:
    claude = FakeProvider("anthropic", [[unauthorized()]])
    h = Harness([slot(claude)])
    for _ in range(3):  # three failures open the circuit; each counts as an anthropic error
        with pytest.raises(AllProvidersFailedError):
            await h.run()
    assert h.sample("picloud_chat_requests_total", provider="none", outcome="error") is None

    with pytest.raises(AllProvidersFailedError) as excinfo:
        await h.run()  # every circuit is open: nothing is attempted

    assert excinfo.value.fallbacks == (Fallback("anthropic", "circuit_open"),)
    assert h.sample("picloud_chat_requests_total", provider="anthropic", outcome="error") == 3
    assert h.sample("picloud_chat_requests_total", provider="none", outcome="error") == 1


async def test_unexpected_exception_is_an_internal_error_fallback() -> None:
    ollama = FakeProvider("ollama", [[RuntimeError("bug")]])
    claude = FakeProvider("anthropic", [ok_reply("ok")])
    h = Harness([slot(ollama), slot(claude)])

    done = (await h.run())[-1]

    assert isinstance(done, Completed)
    assert done.fallbacks == (Fallback("ollama", "internal_error"),)
    assert len(ollama.calls) == 1


async def test_pinned_provider_goes_first_and_takes_the_model_override() -> None:
    ollama = FakeProvider("ollama", [ok_reply("local")])
    claude = FakeProvider("anthropic", [[unauthorized()]])
    h = Harness([slot(ollama), slot(claude)])

    spec = ChatSpec(
        messages=SPEC.messages, system="sys", max_tokens=8, provider="anthropic", model="claude-x"
    )
    events = await h.run(spec)

    assert events[0] == AttemptStarted("anthropic", "claude-x")
    assert events[1] == AttemptStarted("ollama", "ollama-model")  # fallback keeps its own model
    assert claude.calls[0]["model"] == "claude-x"
    assert ollama.calls[0]["model"] == "ollama-model"


async def test_pinned_disabled_provider_is_reported_as_a_fallback() -> None:
    ollama = FakeProvider("ollama", [ok_reply("ok")])
    h = Harness([slot(ollama), slot(None, "openai")])

    spec = ChatSpec(messages=SPEC.messages, system="sys", max_tokens=8, provider="openai")
    done = (await h.run(spec))[-1]

    assert isinstance(done, Completed)
    assert done.fallbacks == (Fallback("openai", "disabled"),)


async def test_passes_request_parameters_to_the_provider() -> None:
    ollama = FakeProvider("ollama", [ok_reply("ok")])
    h = Harness([slot(ollama)])
    await h.run(ChatSpec(messages=SPEC.messages, system="s", max_tokens=99, temperature=0.3))
    assert ollama.calls[0]["max_tokens"] == 99
    assert ollama.calls[0]["temperature"] == 0.3
    assert ollama.calls[0]["messages"] == [ChatMessage("user", "hi")]


async def test_circuit_opens_after_three_failures_and_half_opens_after_cooldown() -> None:
    claude = FakeProvider("anthropic", [[unauthorized()]])
    openai = FakeProvider("openai", [ok_reply("ok")])
    h = Harness([slot(claude), slot(openai)])
    gauge = {"provider": "anthropic"}

    for _ in range(3):
        await h.run()
    assert h.router.circuit_state("anthropic") is CircuitState.OPEN
    assert h.sample("picloud_provider_circuit_state", **gauge) == 2

    done = (await h.run())[-1]  # the open circuit is skipped without a call
    assert isinstance(done, Completed)
    assert done.fallbacks == (Fallback("anthropic", "circuit_open"),)
    assert len(claude.calls) == 3

    h.clock.advance(30)
    assert h.router.circuit_state("anthropic") is CircuitState.HALF_OPEN
    assert h.sample("picloud_provider_circuit_state", **gauge) == 1

    claude._replies = [ok_reply("back")]
    done = (await h.run())[-1]
    assert isinstance(done, Completed)
    assert done.provider == "anthropic"
    assert h.router.circuit_state("anthropic") is CircuitState.CLOSED
    assert h.sample("picloud_provider_circuit_state", **gauge) == 0


async def test_transient_failures_stop_retrying_once_the_circuit_opens() -> None:
    ollama = FakeProvider("ollama", [[timeout()]])
    openai = FakeProvider("openai", [ok_reply("ok")])
    h = Harness([slot(ollama), slot(openai)])

    await h.run()  # three failed attempts open the circuit
    assert h.router.circuit_state("ollama") is CircuitState.OPEN

    h.clock.advance(30)
    await h.run()  # half-open trial fails: no retry, circuit opens again
    assert len(ollama.calls) == 4
    assert h.router.circuit_state("ollama") is CircuitState.OPEN
    assert h.sleeps == [0.5, 1.0]  # and no backoff wait for a retry that cannot happen


async def test_retry_rechecks_the_circuit_after_the_backoff() -> None:
    ollama = FakeProvider("ollama", [[timeout()]])
    openai = FakeProvider("openai", [ok_reply("ok")])
    h = Harness([])
    others_ran = False

    async def sleep(seconds: float) -> None:
        nonlocal others_ran
        if not others_ran:  # while the first request backs off, another one fails twice
            others_ran = True
            await h.run()

    h.router = ProviderRouter(
        [slot(ollama), slot(openai)], metrics=h.metrics, clock=h.clock, sleep=sleep
    )
    done = (await h.run())[-1]

    assert h.router.circuit_state("ollama") is CircuitState.OPEN
    assert isinstance(done, Completed)
    assert done.fallbacks == (Fallback("ollama", "timeout"),)
    assert len(ollama.calls) == 3  # 1 + the other request's 2; no retry into the open circuit


def failing_three_times_then(reply: Reply) -> list[Reply]:
    """Three failures, enough to open the circuit; ``reply`` for every call after them."""
    return [[unauthorized()], [unauthorized()], [unauthorized()], reply]


async def open_circuit_then_cool_down(h: Harness) -> None:
    """Open the anthropic circuit with three failed requests, then wait out the cooldown."""
    for _ in range(3):
        with suppress(AllProvidersFailedError):  # when there is nothing to fall back to
            await h.run()
    assert h.router.circuit_state("anthropic") is CircuitState.OPEN
    assert h.sample(CIRCUIT_GAUGE, provider="anthropic") == 2
    h.clock.advance(30)
    assert h.router.circuit_state("anthropic") is CircuitState.HALF_OPEN
    assert h.sample(CIRCUIT_GAUGE, provider="anthropic") == 1


async def start_held_trial(
    h: Harness, claude: HeldProvider, gate: asyncio.Event
) -> asyncio.Task[list[RouterEvent]]:
    """Start a request and return once it waits at ``gate``, inside the provider, as the trial."""
    claude.gate = gate
    trial = asyncio.create_task(h.run())
    async with asyncio.timeout(GUARD_S):
        await claude.held.wait()
    return trial


async def test_half_open_admits_one_trial_and_others_skip_until_it_ends() -> None:
    claude = HeldProvider("anthropic", failing_three_times_then(ok_reply("back")))
    openai = FakeProvider("openai", [ok_reply("ok")])
    h = Harness([slot(claude), slot(openai)])
    await open_circuit_then_cool_down(h)
    gate = asyncio.Event()
    trial = await start_held_trial(h, claude, gate)  # request 1

    async with asyncio.timeout(GUARD_S):  # a second trial would wait at the gate forever
        done = (await h.run())[-1]  # request 2 skips the provider while the trial is in flight
    assert isinstance(done, Completed)
    assert done.provider == "openai"
    assert done.fallbacks == (Fallback("anthropic", "circuit_open"),)
    assert claude.entered == 4
    assert h.sample(CIRCUIT_GAUGE, provider="anthropic") == 1

    gate.set()
    done = (await trial)[-1]
    assert isinstance(done, Completed)
    assert (done.provider, done.fallbacks) == ("anthropic", ())
    assert h.router.circuit_state("anthropic") is CircuitState.CLOSED
    assert h.sample(CIRCUIT_GAUGE, provider="anthropic") == 0

    done = (await h.run())[-1]  # request 3 uses the provider normally
    assert isinstance(done, Completed)
    assert (done.provider, done.fallbacks) == ("anthropic", ())
    assert claude.entered == 5


async def test_cancelled_trial_frees_the_half_open_slot() -> None:
    claude = HeldProvider("anthropic", failing_three_times_then(ok_reply("back")))
    h = Harness([slot(claude)])
    await open_circuit_then_cool_down(h)
    gate = asyncio.Event()
    trial = await start_held_trial(h, claude, gate)

    trial.cancel()  # the client went away while the trial waited on the provider
    with pytest.raises(asyncio.CancelledError):
        await trial

    # No verdict: still half-open, and the next request becomes the trial.
    assert h.router.circuit_state("anthropic") is CircuitState.HALF_OPEN
    gate.set()
    done = (await h.run())[-1]
    assert isinstance(done, Completed)
    assert done.provider == "anthropic"
    assert claude.entered == 5
    assert h.router.circuit_state("anthropic") is CircuitState.CLOSED


async def test_trial_closed_mid_stream_frees_the_half_open_slot() -> None:
    claude = FakeProvider("anthropic", failing_three_times_then(ok_reply("par", "tial")))
    h = Harness([slot(claude)])
    await open_circuit_then_cool_down(h)

    trial = h.router.stream(SPEC)
    assert await anext(trial) == AttemptStarted("anthropic", "anthropic-model")
    assert await anext(trial) == TextDelta("par")
    await trial.aclose()  # the client went away after the first token

    assert h.router.circuit_state("anthropic") is CircuitState.HALF_OPEN
    done = (await h.run())[-1]
    assert isinstance(done, Completed)
    assert done.provider == "anthropic"
    assert len(claude.calls) == 5
    assert h.router.circuit_state("anthropic") is CircuitState.CLOSED


async def test_bad_requests_do_not_trip_the_circuit() -> None:
    claude = FakeProvider("anthropic", [[ProviderError(ErrorReason.BAD_REQUEST, "too long")]])
    openai = FakeProvider("openai", [ok_reply("ok")])
    h = Harness([slot(claude), slot(openai)])
    for _ in range(5):
        await h.run()
    assert h.router.circuit_state("anthropic") is CircuitState.CLOSED


async def test_unknown_model_from_the_caller_does_not_trip_the_circuit() -> None:
    not_found = ProviderError(ErrorReason.NOT_FOUND, "no such model", status_code=404)
    ollama = FakeProvider("ollama", [[not_found]])
    openai = FakeProvider("openai", [ok_reply("ok")])
    h = Harness([slot(ollama), slot(openai)])
    typo = ChatSpec(messages=SPEC.messages, system="sys", max_tokens=8, model="lama3")

    for _ in range(5):
        done = (await h.run(typo))[-1]
        assert isinstance(done, Completed)
        assert done.fallbacks == (Fallback("ollama", "not_found"),)
    assert h.router.circuit_state("ollama") is CircuitState.CLOSED

    for _ in range(3):  # the configured model is missing: that is the provider's problem
        await h.run()
    assert h.router.circuit_state("ollama") is CircuitState.OPEN


def test_circuit_breaker_unit() -> None:
    clock = FakeClock()
    breaker = CircuitBreaker(failure_threshold=3, cooldown_s=30, clock=clock)

    def state() -> CircuitState:  # re-read each time; the state is time based
        return breaker.state

    breaker.record_failure()
    breaker.record_failure()
    breaker.record_success()  # resets the consecutive count
    breaker.record_failure()
    breaker.record_failure()
    assert state() is CircuitState.CLOSED
    breaker.record_failure()
    assert state() is CircuitState.OPEN
    assert breaker.acquire() is None
    clock.advance(29.9)
    assert state() is CircuitState.OPEN
    clock.advance(0.1)
    assert state() is CircuitState.HALF_OPEN

    # Half-open admits exactly one trial; others skip until the trial gives its slot back.
    trial = breaker.acquire()
    assert trial is not None
    assert trial.trial
    assert breaker.allows(trial)
    assert breaker.acquire() is None
    breaker.release(trial)
    retry = breaker.acquire()
    assert retry is not None
    assert retry.trial
    assert not breaker.allows(trial)  # a released permit no longer counts as the trial
    breaker.record_failure()  # the trial fails: open again for a fresh cooldown
    assert state() is CircuitState.OPEN
    assert not breaker.allows(retry)
    breaker.release(retry)


async def test_aclose_closes_enabled_providers() -> None:
    ollama = FakeProvider("ollama", [ok_reply("ok")])
    h = Harness([slot(ollama), slot(None, "openai")])
    await h.router.aclose()
    assert ollama.closed
