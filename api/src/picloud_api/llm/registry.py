"""Builds the provider fallback chain from settings."""

from picloud_api.config import ProviderName, Settings
from picloud_api.llm.anthropic import AnthropicProvider
from picloud_api.llm.base import ProviderSlot
from picloud_api.llm.ollama import OllamaProvider
from picloud_api.llm.openai_compat import OpenAICompatProvider


def build_provider_slots(settings: Settings) -> list[ProviderSlot]:
    """One slot per name in ``PICLOUD_PROVIDER_ORDER``; unconfigured providers stay disabled."""
    return [_build_slot(name, settings) for name in settings.provider_order]


def _build_slot(name: ProviderName, settings: Settings) -> ProviderSlot:
    timeout = settings.request_timeout_s
    if name == "ollama":
        ollama = (
            OllamaProvider(settings.ollama_url, settings.ollama_model, timeout_s=timeout)
            if settings.ollama_url
            else None
        )
        return ProviderSlot(name, local=True, model=settings.ollama_model, provider=ollama)
    if name == "anthropic":
        key = settings.anthropic_api_key
        claude = (
            AnthropicProvider(key.get_secret_value(), settings.anthropic_model, timeout_s=timeout)
            if key is not None
            else None
        )
        return ProviderSlot(name, local=False, model=settings.anthropic_model, provider=claude)
    key = settings.openai_api_key
    compat = (
        OpenAICompatProvider(
            key.get_secret_value(),
            settings.openai_model,
            base_url=settings.openai_base_url,
            timeout_s=timeout,
        )
        if key is not None
        else None
    )
    return ProviderSlot(name, local=False, model=settings.openai_model, provider=compat)
