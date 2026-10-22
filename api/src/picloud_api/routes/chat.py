"""POST /api/chat: streamed (SSE) or buffered chat with provider fallback."""

import math
from collections.abc import AsyncGenerator
from contextlib import aclosing
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field, field_validator

from picloud_api import sse
from picloud_api.agent_client import AgentUnavailableError
from picloud_api.config import ProviderName
from picloud_api.llm.base import ChatMessage, TextDelta
from picloud_api.llm.prompts import build_system_prompt
from picloud_api.llm.router import (
    AllProvidersFailedError,
    AttemptStarted,
    ChatSpec,
    Completed,
    Fallback,
    RouterEvent,
    StreamInterruptedError,
)
from picloud_api.logging import request_id_var
from picloud_api.security import api_key_matches, client_ip
from picloud_api.services import Services, ServicesDep

router = APIRouter(tags=["chat"])


# --- Guards ----------------------------------------------------------------------------------


async def enforce_rate_limit(request: Request, services: ServicesDep) -> None:
    wait_s = services.limiter.acquire(client_ip(request))
    if wait_s > 0:
        raise HTTPException(
            status_code=429,
            detail="rate limit exceeded",
            headers={"Retry-After": str(math.ceil(wait_s))},
        )


async def require_api_key(
    services: ServicesDep,
    x_api_key: Annotated[str | None, Header()] = None,
) -> None:
    expected = services.settings.api_key
    if expected is not None and not api_key_matches(x_api_key, expected):
        # 403, not 401: the gateway's HTTP basic auth owns 401. Browsers treat any 401 as a
        # rejection of the basic-auth credentials they sent, drop them and prompt for the site
        # password again, so a wrong API key would log the user out of the gateway.
        raise HTTPException(status_code=403, detail="invalid or missing API key")


# --- Schemas ---------------------------------------------------------------------------------


class MessageIn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=8000)


class ChatRequest(BaseModel):
    messages: list[MessageIn] = Field(min_length=1, max_length=50)
    provider: ProviderName | None = None
    model: str | None = Field(default=None, min_length=1, max_length=200)
    include_system_context: bool = True
    stream: bool = True
    max_tokens: int | None = Field(default=None, ge=1)
    temperature: float | None = Field(default=None, ge=0, le=2)

    @field_validator("messages")
    @classmethod
    def _ends_with_user(cls, messages: list[MessageIn]) -> list[MessageIn]:
        if messages[-1].role != "user":
            raise ValueError("the last message must have role 'user'")
        return messages


class UsageOut(BaseModel):
    input_tokens: int
    output_tokens: int


class FallbackOut(BaseModel):
    provider: str
    reason: str


class ChatResponse(BaseModel):
    provider: str
    model: str
    content: str
    usage: UsageOut
    latency_ms: int
    fallbacks: list[FallbackOut]


# --- Route -----------------------------------------------------------------------------------


@router.post(
    "/api/chat",
    dependencies=[Depends(enforce_rate_limit), Depends(require_api_key)],
    response_model=ChatResponse,
    responses={
        200: {"content": {"text/event-stream": {}}, "description": "SSE when stream=true"},
        403: {"description": "Missing or invalid X-API-Key"},
        429: {"description": "Rate limited; see Retry-After"},
        502: {"description": "The provider failed mid-response (stream=false)"},
        503: {"description": "No provider could answer"},
    },
)
async def chat(body: ChatRequest, services: ServicesDep) -> Response | ChatResponse:
    spec = await _build_spec(body, services)
    events = services.router.stream(spec)
    try:
        # The first event is AttemptStarted unless no provider can even be tried.
        first = await anext(events)
    except AllProvidersFailedError as exc:
        return _error_response(503, "all_providers_failed", exc)

    if body.stream:
        return StreamingResponse(
            sse.with_keepalive(_sse_events(first, events)),
            media_type="text/event-stream",
            headers=sse.SSE_HEADERS,
        )
    return await _collect(events)


async def _build_spec(body: ChatRequest, services: Services) -> ChatSpec:
    snapshot = None
    if body.include_system_context:
        try:
            snapshot = await services.agent.snapshot()
        except AgentUnavailableError:
            snapshot = None  # the prompt tells the model telemetry is unavailable
    limit = services.settings.max_tokens
    return ChatSpec(
        messages=tuple(ChatMessage(m.role, m.content) for m in body.messages),
        system=build_system_prompt(snapshot, include_context=body.include_system_context),
        max_tokens=min(body.max_tokens or limit, limit),
        temperature=body.temperature,
        provider=body.provider,
        model=body.model,
    )


async def _sse_events(
    first: RouterEvent, events: AsyncGenerator[RouterEvent, None]
) -> AsyncGenerator[str, None]:
    async with aclosing(events):
        try:
            yield _format(first)
            async for event in events:
                yield _format(event)
        except StreamInterruptedError as exc:
            yield sse.format_event("error", {"code": "provider_error", "message": str(exc)})
        except AllProvidersFailedError as exc:
            yield sse.format_event("error", {"code": "all_providers_failed", "message": str(exc)})


def _format(event: RouterEvent) -> str:
    match event:
        case AttemptStarted(provider=provider, model=model):
            data = {"request_id": request_id_var.get(), "provider": provider, "model": model}
            return sse.format_event("meta", data)
        case TextDelta(text=text):
            return sse.format_event("token", {"text": text})
        case Completed():
            return sse.format_event(
                "done",
                {
                    "provider": event.provider,
                    "model": event.model,
                    "usage": {
                        "input_tokens": event.usage.input_tokens,
                        "output_tokens": event.usage.output_tokens,
                    },
                    "latency_ms": event.latency_ms,
                    "ttft_ms": event.ttft_ms,
                    "fallbacks": _fallbacks(event.fallbacks),
                },
            )


async def _collect(events: AsyncGenerator[RouterEvent, None]) -> Response | ChatResponse:
    parts: list[str] = []
    done: Completed | None = None
    try:
        async with aclosing(events):
            async for event in events:
                if isinstance(event, TextDelta):
                    parts.append(event.text)
                elif isinstance(event, Completed):
                    done = event
    except AllProvidersFailedError as exc:
        return _error_response(503, "all_providers_failed", exc)
    except StreamInterruptedError as exc:
        return _error_response(502, "provider_error", exc)
    if done is None:  # pragma: no cover - the router always ends with Completed or raises
        raise RuntimeError("router finished without a result")
    return ChatResponse(
        provider=done.provider,
        model=done.model,
        content="".join(parts),
        usage=UsageOut(
            input_tokens=done.usage.input_tokens, output_tokens=done.usage.output_tokens
        ),
        latency_ms=done.latency_ms,
        fallbacks=[FallbackOut(provider=f.provider, reason=f.reason) for f in done.fallbacks],
    )


def _error_response(status: int, code: str, exc: Exception) -> JSONResponse:
    content: dict[str, object] = {"detail": str(exc), "code": code}
    if isinstance(exc, AllProvidersFailedError):
        content["fallbacks"] = _fallbacks(exc.fallbacks)
    return JSONResponse(status_code=status, content=content)


def _fallbacks(fallbacks: tuple[Fallback, ...]) -> list[dict[str, str]]:
    return [{"provider": f.provider, "reason": f.reason} for f in fallbacks]
