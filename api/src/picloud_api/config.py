"""Application settings, loaded from environment variables."""

import re
from dataclasses import dataclass
from typing import Annotated, Literal, Self

from pydantic import AliasChoices, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

ProviderName = Literal["ollama", "anthropic", "openai"]
PROVIDER_NAMES: tuple[ProviderName, ...] = ("ollama", "anthropic", "openai")

LogLevel = Literal["debug", "info", "warning", "error", "critical"]

_RATE_PATTERN = re.compile(r"^\s*(\d+)\s*/\s*(second|minute|hour|day)\s*$", re.IGNORECASE)
_PERIOD_SECONDS = {"second": 1.0, "minute": 60.0, "hour": 3600.0, "day": 86400.0}


@dataclass(frozen=True, slots=True)
class RateLimit:
    """A request budget such as ``20/minute``."""

    requests: int
    period_s: float

    @classmethod
    def parse(cls, value: str) -> Self:
        match = _RATE_PATTERN.match(value)
        if match is None:
            raise ValueError(f"expected '<count>/<second|minute|hour|day>', got {value!r}")
        requests = int(match.group(1))
        if requests < 1:
            raise ValueError("rate limit count must be at least 1")
        return cls(requests, _PERIOD_SECONDS[match.group(2).lower()])


def _split_csv(value: object) -> object:
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    return value


class Settings(BaseSettings):
    """Runtime configuration. Every field maps to a ``PICLOUD_*`` variable unless noted."""

    model_config = SettingsConfigDict(env_prefix="PICLOUD_", extra="ignore", frozen=True)

    agent_url: str = "http://agent:9110"
    provider_order: Annotated[list[ProviderName], NoDecode] = Field(
        default_factory=lambda: list(PROVIDER_NAMES)
    )

    ollama_url: str = "http://ollama:11434"  # empty string disables Ollama
    ollama_model: str = "llama3.2:1b"

    # Vendor keys keep their conventional names (no PICLOUD_ prefix); unset disables the provider.
    anthropic_api_key: SecretStr | None = Field(
        default=None, validation_alias=AliasChoices("ANTHROPIC_API_KEY", "anthropic_api_key")
    )
    anthropic_model: str = "claude-haiku-4-5"

    openai_api_key: SecretStr | None = Field(
        default=None, validation_alias=AliasChoices("OPENAI_API_KEY", "openai_api_key")
    )
    openai_base_url: str = "https://api.openai.com/v1"
    openai_model: str = "gpt-4o-mini"

    api_key: SecretStr | None = None  # when set, POST /api/chat requires X-API-Key
    chat_rate_limit: Annotated[RateLimit, NoDecode] = RateLimit(20, 60.0)

    max_tokens: int = Field(default=1024, ge=1)
    request_timeout_s: float = Field(default=60.0, gt=0)
    stream_interval_s: float = Field(default=2.0, gt=0)

    cors_origins: Annotated[list[str], NoDecode] = Field(default_factory=list)

    log_level: LogLevel = "info"
    log_format: Literal["json", "console"] = "json"

    @field_validator("provider_order", mode="before")
    @classmethod
    def _parse_provider_order(cls, value: object) -> object:
        value = _split_csv(value)
        if isinstance(value, list):
            return [str(item).lower() for item in value]
        return value

    @field_validator("provider_order")
    @classmethod
    def _check_provider_order(cls, value: list[ProviderName]) -> list[ProviderName]:
        if not value:
            raise ValueError("at least one provider must be listed")
        if len(set(value)) != len(value):
            raise ValueError("providers must not repeat")
        return value

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _parse_cors_origins(cls, value: object) -> object:
        return _split_csv(value)

    @field_validator("anthropic_api_key", "openai_api_key", "api_key", mode="before")
    @classmethod
    def _blank_secret_is_unset(cls, value: object) -> object:
        # Compose passes unset variables through as empty strings.
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator("agent_url", "ollama_url", "openai_base_url")
    @classmethod
    def _strip_trailing_slash(cls, value: str) -> str:
        return value.strip().rstrip("/")

    @field_validator("chat_rate_limit", mode="before")
    @classmethod
    def _parse_rate_limit(cls, value: object) -> object:
        return RateLimit.parse(value) if isinstance(value, str) else value

    @field_validator("log_level", "log_format", mode="before")
    @classmethod
    def _lowercase(cls, value: object) -> object:
        return value.lower() if isinstance(value, str) else value
