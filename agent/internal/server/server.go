// Package server provides the agent's HTTP routes.
package server

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/Reec1e33/proj2-raspPI-ai-server/agent/internal/collector"
)

// Source provides the latest sample. *collector.Sampler implements it.
type Source interface {
	Latest() (collector.Sample, bool)
}

// New returns the agent's HTTP handler:
//
//	GET /healthz      200 {"status":"ok"}, or 503 before the first sample or
//	                  when the latest one is older than staleAfter
//	GET /metrics      Prometheus exposition from gatherer
//	GET /v1/snapshot  the latest collector.Snapshot as JSON
func New(src Source, gatherer prometheus.Gatherer, staleAfter time.Duration) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		s, ok := src.Latest()
		switch {
		case !ok:
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "starting"})
		case time.Since(s.Time) > staleAfter:
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "stale"})
		default:
			writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		}
	})

	mux.Handle("GET /metrics", promhttp.HandlerFor(gatherer, promhttp.HandlerOpts{}))

	mux.HandleFunc("GET /v1/snapshot", func(w http.ResponseWriter, _ *http.Request) {
		s, ok := src.Latest()
		if !ok {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "no sample collected yet"})
			return
		}
		writeJSON(w, http.StatusOK, s.Snapshot)
	})

	return mux
}

// writeJSON encodes v before writing the status line, so an encoding
// failure becomes a 500 instead of a truncated 200.
func writeJSON(w http.ResponseWriter, status int, v any) {
	body, err := json.Marshal(v)
	if err != nil {
		http.Error(w, "encode response: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(append(body, '\n'))
}
