# ADR-0002: Use a local-first LLM fallback chain with circuit breakers

- Status: Accepted
- Date: 2026-10-02

## Context

The chat can use a local model or a cloud one, and neither is reliable on its
own. Ollama with `llama3.2:1b` is free and keeps the prompt on the Pi, but it's
slow on a Pi CPU, it fails if the model isn't pulled or the container runs out
of memory, and a 4 GB Pi can't run it next to the rest of the stack. Cloud
models (Anthropic, or an OpenAI-compatible API like Groq) are fast, but they
need a key, cost money, and rate-limit. The chat should still answer when one
provider is down, and an answer must never mix text from two models.

## Decision

Send every chat request through an ordered chain of providers
([`router.py`](../../api/src/picloud_api/llm/router.py)). The default is
`ollama,anthropic,openai` (`PICLOUD_PROVIDER_ORDER`), and providers with no URL
or key are skipped. A request can pin which provider goes first.

Before the first token, transient errors (connection errors, timeouts, 429,
5xx) get 2 retries with exponential backoff and jitter, then the router moves
on. After the first token it never switches: a failure ends the stream with an
SSE `error` event. SDK retries are off, so the waits don't stack.

Each provider has a circuit breaker that opens after 3 consecutive failures and
goes half-open after 30 s. In half-open, exactly one trial request goes through
and everything else skips the provider until it finishes. A good trial closes
the circuit and a failed one reopens it for another 30 s. A trial that ends
without a verdict, because the client went away or the error doesn't count,
frees the slot for the next request. `bad_request`, and `not_found` for a model
the caller named, don't count, so one client can't open the circuit for
everyone.

## Consequences

- With a cloud key set, chat keeps working when Ollama is down, and the cloud
  only sees traffic when the local model fails.
- Each answer reports the provider, the `fallbacks`, time to first token, and
  latency. Prometheus gets the same (`picloud_provider_fallbacks_total`,
  `picloud_provider_circuit_state`).
- A failure mid-answer just ends it. The user has to ask again.
- Every failed attempt counts toward the breaker, retries included, so one
  request that times out three times opens the circuit.
- Breaker state is in memory. Restarting the API closes every circuit.
