"""Structured logging: one JSON object per line on stdout, tagged with the request id."""

import json
import logging
import sys
from contextvars import ContextVar
from datetime import UTC, datetime

request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)

# Attributes every LogRecord has; anything else was passed via ``extra=`` and is emitted as a field.
# uvicorn adds "color_message" (ANSI-coloured copy of msg) to its own records.
_RECORD_ATTRS = frozenset(logging.makeLogRecord({}).__dict__) | {
    "message",
    "asctime",
    "color_message",
}

# Loggers that print request bodies or headers at DEBUG. Prompts and API keys must never be logged.
_CHATTY_LOGGERS = ("httpx", "httpcore", "httpx2", "httpcore2", "anthropic", "openai")


def _extra_fields(record: logging.LogRecord) -> dict[str, object]:
    return {k: v for k, v in record.__dict__.items() if k not in _RECORD_ATTRS and k[0] != "_"}


def _timestamp(record: logging.LogRecord) -> str:
    moment = datetime.fromtimestamp(record.created, UTC)
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


class JsonFormatter(logging.Formatter):
    """Formats a record as a single-line JSON object for Loki."""

    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, object] = {
            "ts": _timestamp(record),
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
        }
        request_id = request_id_var.get()
        if request_id is not None:
            entry["request_id"] = request_id
        entry.update(_extra_fields(record))
        if record.exc_info:
            entry["exc_info"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str, ensure_ascii=False)


class ConsoleFormatter(logging.Formatter):
    """Human-readable single-line format for local development."""

    def format(self, record: logging.LogRecord) -> str:
        fields = _extra_fields(record)
        request_id = request_id_var.get()
        if request_id is not None:
            fields = {"request_id": request_id, **fields}
        line = f"{_timestamp(record)} {record.levelname:<8} {record.name}: {record.getMessage()}"
        if fields:
            line += " " + " ".join(f"{key}={value}" for key, value in fields.items())
        if record.exc_info:
            line += "\n" + self.formatException(record.exc_info)
        return line


def configure_logging(level: str, fmt: str) -> None:
    """Route all logs (including uvicorn's) through one stdout handler."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter() if fmt == "json" else ConsoleFormatter())

    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())

    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        uvicorn_logger = logging.getLogger(name)
        uvicorn_logger.handlers.clear()
        uvicorn_logger.propagate = True
    # RequestContextMiddleware writes the access log; uvicorn's would duplicate it.
    logging.getLogger("uvicorn.access").disabled = True

    floor = max(logging.WARNING, root.level)
    for name in _CHATTY_LOGGERS:
        logging.getLogger(name).setLevel(floor)
