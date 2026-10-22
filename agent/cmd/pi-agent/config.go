package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"path"
	"slices"
	"strconv"
	"strings"
	"time"
)

type config struct {
	listen   string
	procfs   string
	sysfs    string
	rootfs   string
	mounts   []string
	interval time.Duration
	demo     bool
	logLevel slog.Level
	version  bool
}

// parseConfig reads flags from args. Every flag defaults to its PI_AGENT_*
// environment variable, so an explicit flag wins over the environment.
func parseConfig(args []string, getenv func(string) string, output io.Writer) (config, error) {
	env := envReader{getenv: getenv}
	var (
		cfg      config
		mounts   string
		logLevel string
	)
	fs := flag.NewFlagSet("pi-agent", flag.ContinueOnError)
	fs.SetOutput(output)
	fs.StringVar(&cfg.listen, "listen", env.str("PI_AGENT_LISTEN", ":9110"), "HTTP listen address (PI_AGENT_LISTEN)")
	fs.StringVar(&cfg.procfs, "procfs", env.str("PI_AGENT_PROCFS", "/proc"), "procfs mount (PI_AGENT_PROCFS)")
	fs.StringVar(&cfg.sysfs, "sysfs", env.str("PI_AGENT_SYSFS", "/sys"), "sysfs mount (PI_AGENT_SYSFS)")
	fs.StringVar(&cfg.rootfs, "rootfs", env.str("PI_AGENT_ROOTFS", "/"), "host root filesystem mount (PI_AGENT_ROOTFS)")
	fs.StringVar(&mounts, "mounts", env.str("PI_AGENT_MOUNTS", "/"), "comma-separated mountpoints to report (PI_AGENT_MOUNTS)")
	fs.DurationVar(&cfg.interval, "interval", env.duration("PI_AGENT_INTERVAL", 2*time.Second), "sampling interval (PI_AGENT_INTERVAL)")
	fs.BoolVar(&cfg.demo, "demo", env.boolean("PI_AGENT_DEMO", false), "serve synthetic Raspberry Pi data (PI_AGENT_DEMO)")
	fs.StringVar(&logLevel, "log-level", env.str("PI_AGENT_LOG_LEVEL", "info"), "debug, info, warn or error (PI_AGENT_LOG_LEVEL)")
	fs.BoolVar(&cfg.version, "version", false, "print the version and exit")

	if err := fs.Parse(args); err != nil {
		return config{}, err
	}
	if fs.NArg() > 0 {
		return config{}, fmt.Errorf("unexpected arguments: %v", fs.Args())
	}

	errs := env.errs
	if err := cfg.logLevel.UnmarshalText([]byte(logLevel)); err != nil {
		errs = append(errs, fmt.Errorf("log level: %w", err))
	}
	if cfg.interval < 100*time.Millisecond {
		errs = append(errs, fmt.Errorf("interval %v is below the 100ms minimum", cfg.interval))
	}
	if _, _, err := net.SplitHostPort(cfg.listen); err != nil {
		errs = append(errs, fmt.Errorf("listen address: %w", err))
	}
	for m := range strings.SplitSeq(mounts, ",") {
		m = strings.TrimSpace(m)
		if m == "" {
			continue
		}
		if !path.IsAbs(m) {
			errs = append(errs, fmt.Errorf("mountpoint %q is not absolute", m))
			continue
		}
		// Each mountpoint is a metric label; a repeated one would make the
		// registry reject the whole scrape.
		if m = path.Clean(m); !slices.Contains(cfg.mounts, m) {
			cfg.mounts = append(cfg.mounts, m)
		}
	}
	return cfg, errors.Join(errs...)
}

// envReader reads typed environment variables and collects parse errors.
type envReader struct {
	getenv func(string) string
	errs   []error
}

func (e *envReader) str(key, def string) string {
	if v := e.getenv(key); v != "" {
		return v
	}
	return def
}

func (e *envReader) duration(key string, def time.Duration) time.Duration {
	v := e.getenv(key)
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		e.errs = append(e.errs, fmt.Errorf("%s: %w", key, err))
		return def
	}
	return d
}

func (e *envReader) boolean(key string, def bool) bool {
	v := e.getenv(key)
	if v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		e.errs = append(e.errs, fmt.Errorf("%s: %w", key, err))
		return def
	}
	return b
}

// healthURL turns a listen address into a URL the healthcheck can dial:
// a wildcard host (":9110", "0.0.0.0:9110", "[::]:9110") becomes loopback.
func healthURL(listen string) (string, error) {
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		return "", err
	}
	if ip := net.ParseIP(host); host == "" || (ip != nil && ip.IsUnspecified()) {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port) + "/healthz", nil
}
