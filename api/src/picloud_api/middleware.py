"""Request context middleware: request id, access log and HTTP metrics."""

import logging
import re
import time
import uuid

from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from picloud_api.logging import request_id_var
from picloud_api.metrics import Metrics

logger = logging.getLogger("picloud_api.access")

# Accept the gateway's X-Request-ID only if it is short and log-safe; otherwise mint one.
_VALID_REQUEST_ID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
# Probe endpoints hit every few seconds; log them at DEBUG to keep the log useful.
_QUIET_PATHS = frozenset({"/metrics", "/api/health", "/api/ready"})
# Any token is a valid HTTP method, so unknown ones share one label value (bounded cardinality).
_KNOWN_METHODS = frozenset({"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"})


def _route_template(scope: Scope) -> str:
    # FastAPI stores the matched route in the scope; its path is the template
    # (e.g. "/api/system"), which keeps metric label cardinality bounded.
    route = scope.get("route")
    path = getattr(route, "path", None)
    return path if isinstance(path, str) else "unmatched"


class RequestContextMiddleware:
    """Pure ASGI middleware, so streaming responses are neither buffered nor cut short."""

    def __init__(self, app: ASGIApp, metrics: Metrics) -> None:
        self.app = app
        self.metrics = metrics

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        incoming = Headers(scope=scope).get("x-request-id", "")
        request_id = incoming if _VALID_REQUEST_ID.match(incoming) else uuid.uuid4().hex
        token = request_id_var.set(request_id)
        started = time.perf_counter()
        status = 500

        async def send_with_request_id(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                MutableHeaders(scope=message).append("X-Request-ID", request_id)
            await send(message)

        try:
            await self.app(scope, receive, send_with_request_id)
        finally:
            duration_s = time.perf_counter() - started
            method, path = scope["method"], scope["path"]
            route = _route_template(scope)
            method_label = method if method in _KNOWN_METHODS else "OTHER"
            self.metrics.observe_http(method_label, route, status, duration_s)
            logger.log(
                logging.DEBUG if path in _QUIET_PATHS else logging.INFO,
                "request",
                extra={
                    "method": method,
                    "path": path,
                    "route": route,
                    "status": status,
                    "duration_ms": round(duration_s * 1000, 1),
                    "client": scope["client"][0] if scope.get("client") else None,
                },
            )
            request_id_var.reset(token)
