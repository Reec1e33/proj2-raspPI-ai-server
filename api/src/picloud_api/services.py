"""Long-lived objects shared by the routes, created in the app lifespan."""

from dataclasses import dataclass
from typing import Annotated, cast

from fastapi import Depends, Request

from picloud_api.agent_client import AgentClient
from picloud_api.config import Settings
from picloud_api.llm.router import ProviderRouter
from picloud_api.metrics import Metrics
from picloud_api.security import TokenBucketLimiter


@dataclass(frozen=True, slots=True)
class Services:
    settings: Settings
    metrics: Metrics
    agent: AgentClient
    router: ProviderRouter
    limiter: TokenBucketLimiter
    started_at: float  # time.monotonic() at startup


def get_services(request: Request) -> Services:
    return cast(Services, request.app.state.services)


ServicesDep = Annotated[Services, Depends(get_services)]
