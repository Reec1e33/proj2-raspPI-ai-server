package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestParseConfig(t *testing.T) {
	defaults := config{
		listen: ":9110", procfs: "/proc", sysfs: "/sys", rootfs: "/",
		mounts: []string{"/"}, interval: 2 * time.Second, logLevel: slog.LevelInfo,
	}
	tests := []struct {
		name    string
		args    []string
		env     map[string]string
		want    func(c *config)
		wantErr string
	}{
		{name: "defaults"},
		{
			name: "environment",
			env: map[string]string{
				"PI_AGENT_LISTEN": "127.0.0.1:9999", "PI_AGENT_PROCFS": "/host/proc",
				"PI_AGENT_SYSFS": "/host/sys", "PI_AGENT_ROOTFS": "/host/root",
				"PI_AGENT_MOUNTS": "/, /boot/firmware/ ,,/mnt/ssd,/boot/firmware,/", "PI_AGENT_INTERVAL": "5s",
				"PI_AGENT_DEMO": "true", "PI_AGENT_LOG_LEVEL": "DEBUG",
			},
			want: func(c *config) {
				c.listen, c.procfs, c.sysfs, c.rootfs = "127.0.0.1:9999", "/host/proc", "/host/sys", "/host/root"
				c.mounts = []string{"/", "/boot/firmware", "/mnt/ssd"}
				c.interval, c.demo, c.logLevel = 5*time.Second, true, slog.LevelDebug
			},
		},
		{
			name: "flags override environment",
			args: []string{"-listen", ":8080", "-demo=false", "-interval", "1s", "-log-level", "warn"},
			env:  map[string]string{"PI_AGENT_LISTEN": ":9999", "PI_AGENT_DEMO": "1", "PI_AGENT_INTERVAL": "10s"},
			want: func(c *config) {
				c.listen, c.demo, c.interval, c.logLevel = ":8080", false, time.Second, slog.LevelWarn
			},
		},
		{name: "version flag", args: []string{"-version"}, want: func(c *config) { c.version = true }},
		{name: "bad duration", env: map[string]string{"PI_AGENT_INTERVAL": "often"}, wantErr: "PI_AGENT_INTERVAL"},
		{name: "bad bool", env: map[string]string{"PI_AGENT_DEMO": "maybe"}, wantErr: "PI_AGENT_DEMO"},
		{name: "bad log level", args: []string{"-log-level", "loud"}, wantErr: "log level"},
		{name: "interval too short", args: []string{"-interval", "1ms"}, wantErr: "minimum"},
		{name: "relative mount", args: []string{"-mounts", "/,data"}, wantErr: "not absolute"},
		{name: "bad listen", args: []string{"-listen", "9110"}, wantErr: "listen address"},
		{name: "unknown flag", args: []string{"-nope"}, wantErr: "not defined"},
		{name: "positional argument", args: []string{"serve"}, wantErr: "unexpected arguments"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			getenv := func(k string) string { return tt.env[k] }
			got, err := parseConfig(tt.args, getenv, io.Discard)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want it to mention %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			want := defaults
			want.mounts = append([]string(nil), defaults.mounts...)
			if tt.want != nil {
				tt.want(&want)
			}
			if !reflect.DeepEqual(got, want) {
				t.Errorf("got  %+v\nwant %+v", got, want)
			}
		})
	}
}

func TestParseConfigHelp(t *testing.T) {
	var out strings.Builder
	_, err := parseConfig([]string{"-h"}, func(string) string { return "" }, &out)
	if !errors.Is(err, flag.ErrHelp) {
		t.Fatalf("err = %v, want flag.ErrHelp", err)
	}
	for _, env := range []string{"PI_AGENT_LISTEN", "PI_AGENT_DEMO", "PI_AGENT_MOUNTS"} {
		if !strings.Contains(out.String(), env) {
			t.Errorf("usage does not mention %s:\n%s", env, out.String())
		}
	}
}

func TestHealthURL(t *testing.T) {
	tests := []struct{ listen, want string }{
		{":9110", "http://127.0.0.1:9110/healthz"},
		{"0.0.0.0:9110", "http://127.0.0.1:9110/healthz"},
		{"[::]:9110", "http://127.0.0.1:9110/healthz"},
		{"127.0.0.1:8080", "http://127.0.0.1:8080/healthz"},
		{"[::1]:9110", "http://[::1]:9110/healthz"},
		{"agent:9110", "http://agent:9110/healthz"},
	}
	for _, tt := range tests {
		if got, err := healthURL(tt.listen); err != nil || got != tt.want {
			t.Errorf("healthURL(%q) = %q, %v; want %q", tt.listen, got, err, tt.want)
		}
	}
	if _, err := healthURL("no-port"); err == nil {
		t.Error("want error for address without port")
	}
}

func TestProbe(t *testing.T) {
	status := http.StatusOK
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(status) }))
	defer ts.Close()

	if err := probe(ts.URL); err != nil {
		t.Errorf("healthy: %v", err)
	}
	status = http.StatusServiceUnavailable
	if err := probe(ts.URL); err == nil {
		t.Error("503 must fail the probe")
	}
	ts.Close()
	if err := probe(ts.URL); err == nil {
		t.Error("closed server must fail the probe")
	}
}

// TestRunDemo starts the full agent in demo mode and checks the wiring of
// sampler, exporter and HTTP routes end to end.
func TestRunDemo(t *testing.T) {
	addr := freeAddr(t)
	cfg, err := parseConfig([]string{"-demo", "-listen", addr, "-interval", "100ms"}, func(string) string { return "" }, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- run(ctx, cfg, slog.New(slog.DiscardHandler)) }()

	url, _ := healthURL(addr)
	deadline := time.Now().Add(5 * time.Second)
	for probe(url) != nil {
		if time.Now().After(deadline) {
			t.Fatal("agent did not become healthy")
		}
		time.Sleep(20 * time.Millisecond)
	}

	base := "http://" + addr
	var snap struct {
		Hostname string `json:"hostname"`
		CPU      struct {
			Cores int `json:"cores"`
		} `json:"cpu"`
	}
	getJSON(t, base+"/v1/snapshot", &snap)
	if snap.Hostname != "picloud" || snap.CPU.Cores != 4 {
		t.Errorf("snapshot = %+v", snap)
	}
	res, err := http.Get(base + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	for _, m := range []string{"pi_cpu_temperature_celsius", "pi_agent_build_info", "go_goroutines"} {
		if !strings.Contains(string(body), m) {
			t.Errorf("/metrics lacks %s", m)
		}
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("run: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("run did not return after cancel")
	}
}

func TestRunFailsWithoutProcfs(t *testing.T) {
	cfg := config{listen: freeAddr(t), procfs: t.TempDir(), interval: time.Second}
	err := run(context.Background(), cfg, slog.New(slog.DiscardHandler))
	if err == nil || !strings.Contains(err.Error(), "-demo") {
		t.Errorf("err = %v, want a hint to use -demo", err)
	}
}

func TestRunFailsWhenPortBusy(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	cfg := config{listen: ln.Addr().String(), demo: true, interval: time.Second}
	if err := run(context.Background(), cfg, slog.New(slog.DiscardHandler)); err == nil {
		t.Error("want error when the port is in use")
	}
}

func freeAddr(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().String()
}

func getJSON(t *testing.T, url string, v any) {
	t.Helper()
	res, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("GET %s: %s", url, res.Status)
	}
	if err := json.NewDecoder(res.Body).Decode(v); err != nil {
		t.Fatal(err)
	}
}
