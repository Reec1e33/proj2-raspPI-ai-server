"""System prompt and the compact telemetry summary appended to it."""

from picloud_api.agent_client import Snapshot

SYSTEM_PROMPT = (
    "You are PiCloud Assistant, built into a self-hosted Raspberry Pi home server. "
    "You help its owner run, monitor and troubleshoot the Pi and the services on it "
    "(Docker containers, Nginx, Ollama, Prometheus, Grafana and Loki). "
    "Be concise and practical, and prefer concrete commands for Raspberry Pi OS (Debian). "
    "When live telemetry is provided, base any diagnosis on those numbers, name the values "
    "that support each conclusion, and never invent metrics that are not listed. "
    "For questions about throttling, heat or power, start from the firmware throttle flags "
    "and the temperature, and say plainly when they show no problem. "
    "Keep answers under about 150 words unless the user asks for more detail."
)

TELEMETRY_UNAVAILABLE = (
    "Live telemetry: unavailable (the PiCloud telemetry agent did not respond). "
    "If the user asks about the Pi's current state, say that live metrics cannot be read "
    "right now and suggest checking the agent container."
)


def build_system_prompt(snapshot: Snapshot | None, *, include_context: bool) -> str:
    """Return the system prompt, with a telemetry summary when context is requested."""
    if not include_context:
        return SYSTEM_PROMPT
    if snapshot is None:
        return f"{SYSTEM_PROMPT}\n\n{TELEMETRY_UNAVAILABLE}"
    return f"{SYSTEM_PROMPT}\n\n{summarize_snapshot(snapshot)}"


def summarize_snapshot(s: Snapshot) -> str:
    """Summarise a snapshot in a few lines, so the model can answer "why is my Pi slow/hot?"."""
    cpu, mem = s.cpu, s.memory
    platform = ", ".join(
        part for part in (s.platform.model, s.platform.os, s.platform.kernel) if part
    )
    # Small local models misread bare numbers, so each value carries its meaning.
    temperature = (
        f"{cpu.temperature_celsius:.1f} °C ({_temperature_note(cpu.temperature_celsius)})"
        if cpu.temperature_celsius is not None
        else "unknown"
    )
    frequency = f", clock {cpu.frequency_mhz:.0f} MHz" if cpu.frequency_mhz is not None else ""
    load = cpu.load_average
    lines = [
        f"Live telemetry from the Pi (collected {s.collected_at.isoformat()}):",
        f"- Host: {s.hostname} ({platform or 'unknown hardware'}, {s.platform.arch})",
        f"- Uptime: {_duration(s.uptime_seconds)}",
        f"- CPU: {cpu.usage_percent:.1f}% used across {cpu.cores} cores, "
        f"load {load.one:.2f}/{load.five:.2f}/{load.fifteen:.2f} (1/5/15 min), "
        f"temperature {temperature}{frequency}",
        f"- Memory: {mem.usage_percent:.1f}% used ({_size(mem.used_bytes)} of "
        f"{_size(mem.total_bytes)}), swap {_size(mem.swap_used_bytes)} of "
        f"{_size(mem.swap_total_bytes)} used",
    ]
    lines += [
        f"- Disk {fs.mountpoint}: {fs.usage_percent:.1f}% used "
        f"({_size(fs.available_bytes)} free of {_size(fs.total_bytes)})"
        for fs in s.filesystems
    ]
    lines.append(f"- Throttling (firmware flags): {_throttling(s)}")
    return "\n".join(lines)


def _temperature_note(celsius: float) -> str:
    if celsius < 60:
        level = "normal"
    elif celsius < 75:
        level = "warm"
    elif celsius < 80:
        level = "hot"
    else:
        level = "very hot"
    return f"{level}; the firmware starts to throttle the CPU at 80 °C"


def _throttling(s: Snapshot) -> str:
    t = s.throttling
    if not t.supported:
        return "not reported on this hardware"
    labels = ("under-voltage", "ARM frequency capped", "throttled", "soft temperature limit")
    now = (t.under_voltage_now, t.frequency_capped_now, t.throttled_now, t.soft_temp_limit_now)
    since_boot = (
        t.under_voltage_occurred,
        t.frequency_capped_occurred,
        t.throttled_occurred,
        t.soft_temp_limit_occurred,
    )
    active = [label for label, flag in zip(labels, now, strict=True) if flag]
    past = [label for label, flag in zip(labels, since_boot, strict=True) if flag]
    if not active and not past:
        return "none now and none since boot (the firmware reports no throttling)"
    # Spell out "now" versus "since boot": small models read a past flag as a current one.
    if not active:
        return (
            "none active now, so the Pi is not throttled at the moment; "
            f"set at some time since boot, but not now: {', '.join(past)}"
        )
    return (
        f"ACTIVE NOW: {', '.join(active)}; set at some time since boot: {', '.join(past) or 'none'}"
    )


def _duration(seconds: float) -> str:
    minutes = int(seconds) // 60
    days, minutes = divmod(minutes, 24 * 60)
    hours, minutes = divmod(minutes, 60)
    return f"{days}d {hours}h {minutes}m"


def _size(num_bytes: int) -> str:
    value = float(num_bytes)
    for unit in ("B", "KiB", "MiB", "GiB"):
        if value < 1024:
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} TiB"
