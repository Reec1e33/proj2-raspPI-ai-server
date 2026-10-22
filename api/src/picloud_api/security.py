"""Security primitives: constant-time API key check, client IP, per-IP token bucket."""

import hmac
import time
from collections import OrderedDict
from collections.abc import Callable

from pydantic import SecretStr
from starlette.requests import HTTPConnection

from picloud_api.config import RateLimit


def api_key_matches(provided: str | None, expected: SecretStr) -> bool:
    """Compare in constant time so the response time does not leak the key."""
    if provided is None:
        return False
    return hmac.compare_digest(provided.encode(), expected.get_secret_value().encode())


def client_ip(conn: HTTPConnection) -> str:
    """The client address used for rate limiting.

    Behind the gateway, uvicorn's ``--proxy-headers`` replaces the peer address with the
    X-Forwarded-For client, but only when the peer is in ``FORWARDED_ALLOW_IPS``. A client
    that talks to the API directly therefore cannot spoof its address with that header.
    """
    return conn.client.host if conn.client else "unknown"


class TokenBucketLimiter:
    """In-memory token bucket per key: bursts up to ``requests``, refills over ``period_s``.

    State is per process, which matches the single-worker deployment on the Pi. The least
    recently used keys are dropped beyond ``max_keys`` to bound memory.
    """

    def __init__(
        self,
        rate: RateLimit,
        *,
        clock: Callable[[], float] = time.monotonic,
        max_keys: int = 10_000,
    ) -> None:
        self._capacity = float(rate.requests)
        self._refill_per_s = rate.requests / rate.period_s
        self._clock = clock
        self._max_keys = max_keys
        self._buckets: OrderedDict[str, tuple[float, float]] = OrderedDict()  # key -> (tokens, at)

    def acquire(self, key: str) -> float:
        """Take one token. Return 0 if allowed, else the seconds until a token is available."""
        now = self._clock()
        tokens, updated = self._buckets.pop(key, (self._capacity, now))
        tokens = min(self._capacity, tokens + (now - updated) * self._refill_per_s)
        wait = 0.0
        if tokens >= 1:
            tokens -= 1
        else:
            wait = (1 - tokens) / self._refill_per_s
        self._buckets[key] = (tokens, now)
        if len(self._buckets) > self._max_keys:
            self._buckets.popitem(last=False)
        return wait
