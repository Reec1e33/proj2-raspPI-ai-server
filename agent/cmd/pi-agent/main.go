// Command pi-agent serves Raspberry Pi host telemetry as JSON and as
// Prometheus metrics.
//
// Usage:
//
//	pi-agent [flags]        run the agent (see -h for flags)
//	pi-agent healthcheck    GET /healthz on the configured address; exit 0 if healthy
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"

	"github.com/Reec1e33/proj2-raspPI-ai-server/agent/internal/collector"
	"github.com/Reec1e33/proj2-raspPI-ai-server/agent/internal/demo"
	"github.com/Reec1e33/proj2-raspPI-ai-server/agent/internal/exporter"
	"github.com/Reec1e33/proj2-raspPI-ai-server/agent/internal/server"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

func main() {
	args := os.Args[1:]
	if len(args) > 0 && args[0] == "healthcheck" {
		// Distroless images have no shell or curl, so the Docker
		// HEALTHCHECK calls the binary itself.
		os.Exit(healthcheck(args[1:]))
	}

	cfg, err := parseConfig(args, os.Getenv, os.Stderr)
	if errors.Is(err, flag.ErrHelp) {
		return
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "pi-agent:", err)
		os.Exit(2)
	}
	if cfg.version {
		fmt.Println(version)
		return
	}

	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.logLevel}))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	err = run(ctx, cfg, log)
	stop()
	if err != nil {
		log.Error("pi-agent stopped", "error", err.Error())
		os.Exit(1)
	}
}

func run(ctx context.Context, cfg config, log *slog.Logger) error {
	var src collector.Source
	mode := "host"
	if cfg.demo {
		mode = "demo"
		src = demo.New(uint64(time.Now().UnixNano()), cfg.mounts)
	} else {
		host := collector.NewHost(collector.HostConfig{
			Procfs: cfg.procfs, Sysfs: cfg.sysfs, Rootfs: cfg.rootfs, Mounts: cfg.mounts,
		})
		if err := host.Check(); err != nil {
			return fmt.Errorf("procfs is not readable (%w); use -demo on hosts without procfs", err)
		}
		src = host
	}

	sampler := collector.NewSampler(src, cfg.interval, log)
	reg := prometheus.NewRegistry()
	reg.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		exporter.New(sampler, version),
	)

	srv := &http.Server{
		Handler: server.New(sampler, reg, 3*cfg.interval),
		// A scrape or snapshot only serialises cached data, so short
		// timeouts are safe and bound slow or idle clients.
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
		ErrorLog:          slog.NewLogLogger(log.Handler(), slog.LevelWarn),
	}
	ln, err := net.Listen("tcp", cfg.listen)
	if err != nil {
		return err
	}

	var wg sync.WaitGroup
	samplerCtx, stopSampler := context.WithCancel(ctx)
	defer func() {
		stopSampler()
		wg.Wait()
	}()
	wg.Go(func() { sampler.Run(samplerCtx) })

	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.Serve(ln) }()
	log.Info("pi-agent started",
		"version", version, "mode", mode, "listen", ln.Addr().String(),
		"interval", cfg.interval.String(), "mounts", cfg.mounts)

	select {
	case err := <-serveErr:
		return err
	case <-ctx.Done():
	}

	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	return nil
}

// healthcheck exits 0 when /healthz on the configured listen address
// answers 200, and 1 otherwise.
func healthcheck(args []string) int {
	cfg, err := parseConfig(args, os.Getenv, io.Discard)
	if err != nil {
		fmt.Fprintln(os.Stderr, "healthcheck:", err)
		return 1
	}
	url, err := healthURL(cfg.listen)
	if err != nil {
		fmt.Fprintln(os.Stderr, "healthcheck:", err)
		return 1
	}
	if err := probe(url); err != nil {
		fmt.Fprintln(os.Stderr, "healthcheck:", err)
		return 1
	}
	return 0
}

func probe(url string) error {
	client := http.Client{Timeout: 3 * time.Second}
	res, err := client.Get(url)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("%s returned %s", url, res.Status)
	}
	return nil
}
