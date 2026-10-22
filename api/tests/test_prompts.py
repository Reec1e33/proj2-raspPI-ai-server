import pytest

from picloud_api.agent_client import Snapshot
from picloud_api.llm.prompts import (
    SYSTEM_PROMPT,
    TELEMETRY_UNAVAILABLE,
    build_system_prompt,
    summarize_snapshot,
)
from tests.conftest import SNAPSHOT, snapshot_data


def test_without_context_is_the_bare_persona() -> None:
    snapshot = Snapshot.model_validate(SNAPSHOT)
    assert build_system_prompt(snapshot, include_context=False) == SYSTEM_PROMPT


def test_agent_down_is_stated_instead_of_failing() -> None:
    prompt = build_system_prompt(None, include_context=True)
    assert prompt.startswith(SYSTEM_PROMPT)
    assert prompt.endswith(TELEMETRY_UNAVAILABLE)


def test_summary_contains_the_key_health_signals() -> None:
    summary = summarize_snapshot(Snapshot.model_validate(SNAPSHOT))

    assert "collected 2026-10-02T12:00:00+00:00" in summary
    assert (
        "Host: picloud (Raspberry Pi 5 Model B Rev 1.0, Debian GNU/Linux 12 (bookworm)" in summary
    )
    assert "Uptime: 1d 0h 0m" in summary
    assert "CPU: 12.3% used across 4 cores" in summary
    assert "load 0.42/0.35/0.30" in summary
    assert "temperature 51.2 °C (normal; the firmware starts to throttle" in summary
    assert "clock 2400 MHz" in summary
    assert "Memory: 28.9% used (2.3 GiB of 7.9 GiB), swap 0 B of 512.0 MiB used" in summary
    assert "Disk /: 45.0% used (28.9 GiB free of 57.7 GiB)" in summary
    assert (
        "Throttling (firmware flags): none active now, so the Pi is not throttled at the moment; "
        "set at some time since boot, but not now: under-voltage, throttled" in summary
    )


def test_summary_handles_missing_sensors() -> None:
    data = snapshot_data(
        platform={"model": None, "os": None, "kernel": None, "arch": "arm64"},
        throttling={**SNAPSHOT["throttling"], "supported": False, "raw": None},
    )
    data["cpu"] = {**SNAPSHOT["cpu"], "temperature_celsius": None, "frequency_mhz": None}

    summary = summarize_snapshot(Snapshot.model_validate(data))

    assert "Host: picloud (unknown hardware, arm64)" in summary
    assert "temperature unknown" in summary
    assert "MHz" not in summary
    assert "Throttling (firmware flags): not reported on this hardware" in summary


def test_summary_reports_active_throttling() -> None:
    data = snapshot_data()
    data["throttling"] = {**SNAPSHOT["throttling"], "under_voltage_now": True}
    summary = summarize_snapshot(Snapshot.model_validate(data))
    assert (
        "Throttling (firmware flags): ACTIVE NOW: under-voltage; set at some time since boot:"
        in summary
    )


def test_summary_states_plainly_when_nothing_is_throttled() -> None:
    data = snapshot_data()
    flags = {k: False for k in SNAPSHOT["throttling"] if k not in ("supported", "raw")}
    data["throttling"] = {**SNAPSHOT["throttling"], **flags}
    summary = summarize_snapshot(Snapshot.model_validate(data))
    assert "none now and none since boot (the firmware reports no throttling)" in summary


@pytest.mark.parametrize(
    ("celsius", "level"),
    [(45.0, "normal"), (60.0, "warm"), (75.0, "hot"), (80.0, "very hot")],
)
def test_temperature_carries_its_meaning(celsius: float, level: str) -> None:
    data = snapshot_data()
    data["cpu"] = {**SNAPSHOT["cpu"], "temperature_celsius": celsius}
    summary = summarize_snapshot(Snapshot.model_validate(data))
    assert f"temperature {celsius:.1f} °C ({level}; the firmware starts to throttle" in summary


def test_prompt_with_context_appends_the_summary() -> None:
    snapshot = Snapshot.model_validate(SNAPSHOT)
    prompt = build_system_prompt(snapshot, include_context=True)
    assert prompt == f"{SYSTEM_PROMPT}\n\n{summarize_snapshot(snapshot)}"
