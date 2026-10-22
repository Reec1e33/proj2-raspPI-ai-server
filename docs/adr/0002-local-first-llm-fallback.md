# ADR-0002: Use a local-first LLM fallback chain with circuit breakers

- Status: Accepted
- Date: 2026-10-02

## Context

The chat can use a local model or a cloud model.

- A local model (Ollama with `llama3.2:1b`) costs nothing, and the prompt stays
  on the Pi. On a Pi CPU it is slow. It can also fail: the model is not pulled,
  or the container stops because it has no memory.
- A 4 GB Pi cannot run Ollama next to the rest of the stack.
- Cloud models (Anthropic, OpenAI-compatible APIs such as Groq) are fast. They
  need an API key, they cost money, and they can return rate-limit errors.

A user must get an answer when one provider fails. A partial answer must not
mix text from two models.

## Decision

The API sends each chat request through an ordered chain of providers
([`router.py`](../../api/src/picloud_api/llm/router.py)).

- The default order is `ollama,anthropic,openai`
  (`PICLOUD_PROVIDER_ORDER`). The router skips a provider that has no URL or no
  key.
- Before the first token, the router retries a transient error 2 times, with
  exponential backoff and jitter. Transient errors are connection errors,
  timeouts, HTTP 429 and HTTP 5xx. Then the router tries the next provider.
- After the first token, the router never changes provider. It sends an SSE
  `error` event.
- Each provider has a circuit breaker. It opens after 3 consecutive failed
  calls, and goes to half-open after 30 s.
- A `bad_request` error does not count as a circuit failure. A `not_found`
  error for a model that the caller named does not count either. Thus one
  client cannot open the circuit for all users.
- The SDK retries are off. The router owns all retries, so the waits do not
  multiply.
- A request can pin the first provider (`provider`). The chain continues after
  it.

## Consequences

- The chat works while Ollama is down, if a cloud key is set.
- The cloud provider gets requests only when the local model fails, so the
  cloud cost stays low.
- Each answer reports the provider that answered, the providers that failed
  (`fallbacks`), the time to first token and the latency. Prometheus gets the
  same data (`picloud_provider_fallbacks_total`,
  `picloud_provider_circuit_state`).
- A failure after the first token ends the answer. The user must ask again.
- In the half-open state, the breaker lets one trial request through. Other
  requests skip the provider until the trial ends. A cancelled trial frees the
  slot, so the breaker cannot stay half-open.
- The circuit state is in memory. A restart of the API closes all circuits.
