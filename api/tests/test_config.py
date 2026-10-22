import pytest
from pydantic import ValidationError

from picloud_api.config import RateLimit, Settings
from picloud_api.llm.anthropic import AnthropicProvider
from picloud_api.llm.ollama import OllamaProvider
from picloud_api.llm.openai_compat import OpenAICompatProvider
from picloud_api.llm.registry import build_provider_slots


def test_defaults_match_the_contract() -> None:
    settings = Settings()
    assert settings.agent_url == "http://agent:9110"
    assert settings.provider_order == ["ollama", "anthropic", "openai"]
    assert settings.ollama_url == "http://ollama:11434"
    assert settings.ollama_model == "llama3.2:1b"
    assert settings.anthropic_api_key is None
    assert settings.anthropic_model == "claude-haiku-4-5"
    assert settings.openai_api_key is None
    assert settings.openai_base_url == "https://api.openai.com/v1"
    assert settings.openai_model == "gpt-4o-mini"
    assert settings.api_key is None
    assert settings.chat_rate_limit == RateLimit(20, 60.0)
    assert settings.max_tokens == 1024
    assert settings.request_timeout_s == 60
    assert settings.stream_interval_s == 2
    assert settings.cors_origins == []
    assert settings.log_level == "info"
    assert settings.log_format == "json"


def test_reads_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PICLOUD_PROVIDER_ORDER", " Anthropic, openai ")
    monkeypatch.setenv("PICLOUD_CORS_ORIGINS", "http://localhost:5173, https://pi.local")
    monkeypatch.setenv("PICLOUD_CHAT_RATE_LIMIT", "5/second")
    monkeypatch.setenv("PICLOUD_AGENT_URL", "http://agent:9110/")
    monkeypatch.setenv("PICLOUD_OLLAMA_URL", "")
    monkeypatch.setenv("PICLOUD_LOG_LEVEL", "DEBUG")
    monkeypatch.setenv("PICLOUD_MAX_TOKENS", "256")
    monkeypatch.setenv("PICLOUD_API_KEY", "s3cret")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    monkeypatch.setenv("OPENAI_API_KEY", "  ")

    settings = Settings()

    assert settings.provider_order == ["anthropic", "openai"]
    assert settings.cors_origins == ["http://localhost:5173", "https://pi.local"]
    assert settings.chat_rate_limit == RateLimit(5, 1.0)
    assert settings.agent_url == "http://agent:9110"
    assert settings.ollama_url == ""
    assert settings.log_level == "debug"
    assert settings.max_tokens == 256
    assert settings.api_key is not None
    assert settings.api_key.get_secret_value() == "s3cret"
    assert settings.anthropic_api_key is not None
    assert settings.anthropic_api_key.get_secret_value() == "sk-ant-test"
    assert settings.openai_api_key is None  # blank means unset


def test_secrets_are_masked_in_repr() -> None:
    settings = Settings(anthropic_api_key="sk-ant-test", api_key="s3cret")
    assert "sk-ant-test" not in repr(settings)
    assert "s3cret" not in repr(settings)


@pytest.mark.parametrize(
    ("env", "value"),
    [
        ("PICLOUD_PROVIDER_ORDER", "ollama,ollama"),
        ("PICLOUD_PROVIDER_ORDER", "ollama,gemini"),
        ("PICLOUD_PROVIDER_ORDER", " , "),
        ("PICLOUD_CHAT_RATE_LIMIT", "20 per minute"),
        ("PICLOUD_CHAT_RATE_LIMIT", "0/minute"),
        ("PICLOUD_MAX_TOKENS", "0"),
        ("PICLOUD_REQUEST_TIMEOUT_S", "-1"),
        ("PICLOUD_LOG_FORMAT", "xml"),
    ],
)
def test_rejects_invalid_values(monkeypatch: pytest.MonkeyPatch, env: str, value: str) -> None:
    monkeypatch.setenv(env, value)
    with pytest.raises(ValidationError):
        Settings()


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("20/minute", RateLimit(20, 60.0)),
        ("1/second", RateLimit(1, 1.0)),
        (" 100 / Hour ", RateLimit(100, 3600.0)),
        ("500/day", RateLimit(500, 86400.0)),
    ],
)
def test_rate_limit_parse(text: str, expected: RateLimit) -> None:
    assert RateLimit.parse(text) == expected


async def test_registry_disables_unconfigured_providers() -> None:
    slots = build_provider_slots(Settings(ollama_url=""))
    assert [(s.name, s.enabled, s.local) for s in slots] == [
        ("ollama", False, True),
        ("anthropic", False, False),
        ("openai", False, False),
    ]


async def test_registry_builds_configured_providers_in_order() -> None:
    settings = Settings(
        provider_order="openai,anthropic,ollama",
        anthropic_api_key="sk-ant-test",
        openai_api_key="sk-test",
        openai_base_url="https://api.groq.com/openai/v1",
    )
    slots = build_provider_slots(settings)
    try:
        assert [s.name for s in slots] == ["openai", "anthropic", "ollama"]
        assert isinstance(slots[0].provider, OpenAICompatProvider)
        assert isinstance(slots[1].provider, AnthropicProvider)
        assert isinstance(slots[2].provider, OllamaProvider)
        assert [s.model for s in slots] == ["gpt-4o-mini", "claude-haiku-4-5", "llama3.2:1b"]
    finally:
        for s in slots:
            if s.provider is not None:
                await s.provider.aclose()
