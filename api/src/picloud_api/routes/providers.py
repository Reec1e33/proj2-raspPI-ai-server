"""LLM providers in fallback order, with their circuit breaker state."""

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

from picloud_api.services import ServicesDep

router = APIRouter()


class ProviderInfo(BaseModel):
    name: str
    enabled: bool
    local: bool
    model: str
    circuit: Literal["closed", "open", "half_open"]


@router.get("/api/providers", tags=["chat"])
async def list_providers(services: ServicesDep) -> list[ProviderInfo]:
    llm = services.router
    return [
        ProviderInfo(
            name=slot.name,
            enabled=slot.enabled,
            local=slot.local,
            model=slot.model,
            circuit=llm.circuit_state(slot.name).value,
        )
        for slot in llm.slots
    ]
