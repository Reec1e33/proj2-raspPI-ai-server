package server

import (
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/Reec1e33/proj2-raspPI-ai-server/agent/internal/collector"
)

type fakeSource struct {
	sample collector.Sample
	ok     bool
}

func (f fakeSource) Latest() (collector.Sample, bool) { return f.sample, f.ok }

func sampleAt(t time.Time) collector.Sample {
	r := collector.Reading{
		Time:     t,
		Hostname: "picloud",
		Platform: collector.Platform{Arch: "arm64"},
		CPU:      &collector.CPUStat{Total: collector.CPUTimes{User: 1, Idle: 3}},
	}
	return collector.BuildSample(nil, r)
}

func do(t *testing.T, h http.Handler, method, path string) (*http.Response, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(method, path, nil))
	res := rec.Result()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return res, string(body)
}

func TestHealthz(t *testing.T) {
	tests := []struct {
		name       string
		src        fakeSource
		wantStatus int
		wantBody   string
	}{
		{name: "no sample yet", src: fakeSource{}, wantStatus: 503, wantBody: `{"status":"starting"}`},
		{name: "fresh", src: fakeSource{sample: sampleAt(time.Now()), ok: true}, wantStatus: 200, wantBody: `{"status":"ok"}`},
		{name: "stale", src: fakeSource{sample: sampleAt(time.Now().Add(-time.Minute)), ok: true}, wantStatus: 503, wantBody: `{"status":"stale"}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := New(tt.src, prometheus.NewRegistry(), 10*time.Second)
			res, body := do(t, h, http.MethodGet, "/healthz")
			if res.StatusCode != tt.wantStatus || strings.TrimSpace(body) != tt.wantBody {
				t.Errorf("got %d %s, want %d %s", res.StatusCode, body, tt.wantStatus, tt.wantBody)
			}
			if ct := res.Header.Get("Content-Type"); ct != "application/json" {
				t.Errorf("Content-Type = %q", ct)
			}
		})
	}
}

func TestSnapshot(t *testing.T) {
	h := New(fakeSource{}, prometheus.NewRegistry(), time.Minute)
	if res, _ := do(t, h, http.MethodGet, "/v1/snapshot"); res.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("before first sample: status %d, want 503", res.StatusCode)
	}

	h = New(fakeSource{sample: sampleAt(time.Now()), ok: true}, prometheus.NewRegistry(), time.Minute)
	res, body := do(t, h, http.MethodGet, "/v1/snapshot")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d: %s", res.StatusCode, body)
	}
	if cc := res.Header.Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q", cc)
	}
	var snap map[string]any
	if err := json.Unmarshal([]byte(body), &snap); err != nil {
		t.Fatal(err)
	}
	if snap["hostname"] != "picloud" || snap["cpu"].(map[string]any)["usage_percent"] != 25.0 {
		t.Errorf("unexpected snapshot: %s", body)
	}
	if v, ok := snap["platform"].(map[string]any)["model"]; !ok || v != nil {
		t.Errorf("platform.model must be present and null, got %v (present=%v)", v, ok)
	}
}

func TestSnapshotEncodeError(t *testing.T) {
	s := sampleAt(time.Now())
	nan := math.NaN()
	s.Snapshot.CPU.TemperatureCelsius = &nan
	h := New(fakeSource{sample: s, ok: true}, prometheus.NewRegistry(), time.Minute)
	if res, _ := do(t, h, http.MethodGet, "/v1/snapshot"); res.StatusCode != http.StatusInternalServerError {
		t.Errorf("status %d, want 500", res.StatusCode)
	}
}

func TestMetrics(t *testing.T) {
	reg := prometheus.NewRegistry()
	reg.MustRegister(prometheus.NewGaugeFunc(prometheus.GaugeOpts{Name: "pi_test", Help: "test"}, func() float64 { return 7 }))
	h := New(fakeSource{}, reg, time.Minute)

	res, body := do(t, h, http.MethodGet, "/metrics")
	if res.StatusCode != http.StatusOK || !strings.Contains(body, "pi_test 7") {
		t.Errorf("got %d:\n%s", res.StatusCode, body)
	}
}

func TestRouting(t *testing.T) {
	h := New(fakeSource{sample: sampleAt(time.Now()), ok: true}, prometheus.NewRegistry(), time.Minute)
	tests := []struct {
		method, path string
		want         int
	}{
		{http.MethodPost, "/v1/snapshot", http.StatusMethodNotAllowed},
		{http.MethodDelete, "/healthz", http.StatusMethodNotAllowed},
		{http.MethodHead, "/healthz", http.StatusOK},
		{http.MethodGet, "/", http.StatusNotFound},
		{http.MethodGet, "/v1/snapshot/extra", http.StatusNotFound},
	}
	for _, tt := range tests {
		if res, _ := do(t, h, tt.method, tt.path); res.StatusCode != tt.want {
			t.Errorf("%s %s = %d, want %d", tt.method, tt.path, res.StatusCode, tt.want)
		}
	}
}
