"""Prometheus metrics, kept in a per-app registry so every app instance is isolated."""

from collections.abc import Callable

from prometheus_client import (
    CONTENT_TYPE_LATEST,
    CollectorRegistry,
    Counter,
    Gauge,
    Histogram,
    disable_created_metrics,
    generate_latest,
)
from prometheus_client.gc_collector import GCCollector
from prometheus_client.platform_collector import PlatformCollector
from prometheus_client.process_collector import ProcessCollector

# *_created series double the counter cardinality and nothing here needs them.
disable_created_metrics()  # type: ignore[no-untyped-call]

_LLM_LATENCY_BUCKETS = (0.1, 0.25, 0.5, 1.0, 2.0, 5.0, 10.0, 20.0, 30.0, 60.0, 120.0)


class Metrics:
    """All API metrics. Names and labels follow the PiCloud integration contract."""

    content_type = CONTENT_TYPE_LATEST

    def __init__(self, version: str) -> None:
        self.registry = CollectorRegistry()
        ProcessCollector(registry=self.registry)
        PlatformCollector(registry=self.registry)
        GCCollector(registry=self.registry)

        self.http_requests = Counter(
            "picloud_http_requests_total",
            "HTTP requests by method, route template and status code.",
            ["method", "route", "status"],
            registry=self.registry,
        )
        self.http_duration = Histogram(
            "picloud_http_request_duration_seconds",
            "HTTP request duration by method and route template (whole body for streams).",
            ["method", "route"],
            registry=self.registry,
        )
        self.chat_requests = Counter(
            "picloud_chat_requests_total",
            "Chat completions per provider; error counts each provider that failed a request, "
            'and provider="none" counts requests that no provider could attempt.',
            ["provider", "outcome"],
            registry=self.registry,
        )
        self.chat_tokens = Counter(
            "picloud_chat_tokens_total",
            "Tokens reported by providers.",
            ["provider", "direction"],
            registry=self.registry,
        )
        self.chat_ttft = Histogram(
            "picloud_chat_ttft_seconds",
            "Time from the start of routing to the first token, retries and fallbacks included.",
            ["provider"],
            buckets=_LLM_LATENCY_BUCKETS,
            registry=self.registry,
        )
        self.chat_duration = Histogram(
            "picloud_chat_duration_seconds",
            "Time from the start of provider routing to the end of a successful completion.",
            ["provider"],
            buckets=_LLM_LATENCY_BUCKETS,
            registry=self.registry,
        )
        self.provider_fallbacks = Counter(
            "picloud_provider_fallbacks_total",
            "Times the router moved past a provider, by reason.",
            ["provider", "reason"],
            registry=self.registry,
        )
        self.circuit_state = Gauge(
            "picloud_provider_circuit_state",
            "Circuit breaker state per provider: 0 closed, 1 half_open, 2 open.",
            ["provider"],
            registry=self.registry,
        )
        Gauge(
            "picloud_build_info",
            "Build information; the value is always 1.",
            ["version"],
            registry=self.registry,
        ).labels(version).set(1)

    def observe_http(self, method: str, route: str, status: int, duration_s: float) -> None:
        self.http_requests.labels(method, route, str(status)).inc()
        self.http_duration.labels(method, route).observe(duration_s)

    def track_circuit(self, provider: str, read_state: Callable[[], float]) -> None:
        """Report the circuit state on every scrape (half-open is time based, so it is polled)."""
        self.circuit_state.labels(provider).set_function(read_state)

    def render(self) -> bytes:
        return generate_latest(self.registry)
