import json
import logging
from collections.abc import Iterator

import pytest

from picloud_api.logging import (
    ConsoleFormatter,
    JsonFormatter,
    configure_logging,
    request_id_var,
)


def record(msg: str = "chat completed", **extra: object) -> logging.LogRecord:
    rec = logging.makeLogRecord({"name": "picloud_api.test", "levelno": 20, "levelname": "INFO"})
    rec.msg = msg
    rec.__dict__.update(extra)
    return rec


@pytest.fixture
def request_id() -> Iterator[str]:
    token = request_id_var.set("req-42")
    yield "req-42"
    request_id_var.reset(token)


def test_json_line_has_request_id_and_extra_fields(request_id: str) -> None:
    line = JsonFormatter().format(record(provider="ollama", latency_ms=812, color_message="x"))
    entry = json.loads(line)
    assert entry["msg"] == "chat completed"
    assert entry["level"] == "info"
    assert entry["logger"] == "picloud_api.test"
    assert entry["request_id"] == request_id
    assert entry["provider"] == "ollama"
    assert entry["latency_ms"] == 812
    assert entry["ts"].endswith("Z")
    assert "color_message" not in entry
    assert "\n" not in line


def test_json_includes_exceptions() -> None:
    try:
        raise ValueError("boom")
    except ValueError:
        rec = record()
        rec.exc_info = __import__("sys").exc_info()
    entry = json.loads(JsonFormatter().format(rec))
    assert "ValueError: boom" in entry["exc_info"]
    assert "request_id" not in entry


def test_console_format(request_id: str) -> None:
    line = ConsoleFormatter().format(record(provider="ollama"))
    assert "INFO" in line
    assert "chat completed" in line
    assert f"request_id={request_id} provider=ollama" in line


def test_configure_logging_routes_everything_through_one_handler() -> None:
    root = logging.getLogger()
    saved = root.handlers[:], root.level
    try:
        configure_logging("debug", "json")
        assert len(root.handlers) == 1
        assert isinstance(root.handlers[0].formatter, JsonFormatter)
        assert root.level == logging.DEBUG
        # SDK debug logs include request bodies (prompts) and must stay quiet.
        assert logging.getLogger("anthropic").level == logging.WARNING
        assert logging.getLogger("httpx2").level == logging.WARNING
        assert logging.getLogger("uvicorn.access").disabled
        assert logging.getLogger("uvicorn.error").propagate
        configure_logging("info", "console")
        assert isinstance(root.handlers[0].formatter, ConsoleFormatter)
    finally:
        root.handlers[:], level = saved
        root.setLevel(level)
