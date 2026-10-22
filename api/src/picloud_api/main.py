"""FastAPI application factory. ``uvicorn picloud_api.main:app`` serves the default instance."""

import logging
import time
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from picloud_api import __version__
from picloud_api.agent_client import AgentClient
from picloud_api.config import Settings
from picloud_api.llm.base import ProviderSlot
from picloud_api.llm.registry import build_provider_slots
from picloud_api.llm.router import ProviderRouter
from picloud_api.logging import configure_logging
from picloud_api.metrics import Metrics
from picloud_api.middleware import RequestContextMiddleware
from picloud_api.routes import chat, health, providers, system
from picloud_api.security import TokenBucketLimiter
from picloud_api.services import Services

logger = logging.getLogger(__name__)


async def validation_error_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    """FastAPI's 422 handler, minus the echoed ``input`` of each error.

    Python's JSON parser accepts NaN and Infinity, which cannot be rendered back as JSON,
    so echoing them turned a 422 into a 500. It also echoed whole prompts back.
    """
    errors = [{k: v for k, v in error.items() if k != "input"} for error in exc.errors()]
    return JSONResponse(status_code=422, content={"detail": jsonable_encoder(errors)})


def create_app(
    settings: Settings | None = None, *, provider_slots: Sequence[ProviderSlot] | None = None
) -> FastAPI:
    """Build the app. ``provider_slots`` replaces the providers built from settings (tests)."""
    settings = settings or Settings()
    configure_logging(settings.log_level, settings.log_format)
    metrics = Metrics(__version__)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        slots = provider_slots if provider_slots is not None else build_provider_slots(settings)
        services = Services(
            settings=settings,
            metrics=metrics,
            agent=AgentClient(settings.agent_url),
            router=ProviderRouter(slots, metrics=metrics),
            limiter=TokenBucketLimiter(settings.chat_rate_limit),
            started_at=time.monotonic(),
        )
        app.state.services = services
        logger.info(
            "picloud-api started",
            extra={
                "version": __version__,
                "providers": [s.name for s in slots if s.enabled],
                "api_key_required": settings.api_key is not None,
            },
        )
        try:
            yield
        finally:
            await services.router.aclose()
            await services.agent.aclose()

    app = FastAPI(
        title="PiCloud API",
        version=__version__,
        summary="AI gateway and system telemetry API for a Raspberry Pi home server.",
        lifespan=lifespan,
        docs_url="/api/docs",
        redoc_url=None,
        openapi_url="/api/openapi.json",
        exception_handlers={RequestValidationError: validation_error_handler},
    )
    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_methods=["GET", "POST"],
            allow_headers=["Content-Type", "X-API-Key", "X-Request-ID"],
            expose_headers=["X-Request-ID"],
        )
    # Added last, so it is outermost: every response (CORS preflights included) gets an id.
    app.add_middleware(RequestContextMiddleware, metrics=metrics)

    for module in (health, system, providers, chat):
        app.include_router(module.router)
    return app


app = create_app()
