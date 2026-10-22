package collector

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"
)

// scriptedSource returns its readings in order and repeats the last one.
type scriptedSource struct {
	mu       sync.Mutex
	readings []Reading
	calls    int
}

func (s *scriptedSource) Read(context.Context) Reading {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.readings[min(s.calls, len(s.readings)-1)]
	s.calls++
	return r
}

func newBufferLogger() (*slog.Logger, *bytes.Buffer) {
	var buf bytes.Buffer
	return slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo})), &buf
}

func TestSamplerCollect(t *testing.T) {
	t0 := time.Now()
	errBoom := errors.New("boom")
	src := &scriptedSource{readings: []Reading{
		{
			Time:    t0,
			CPU:     &CPUStat{Total: CPUTimes{User: 0, Idle: 100}},
			Network: []NetCounters{{Interface: "eth0", RxBytes: 0}},
			Errors:  map[string]error{CollectorThermal: errBoom},
		},
		{
			Time:    t0.Add(2 * time.Second),
			CPU:     &CPUStat{Total: CPUTimes{User: 10, Idle: 190}},
			Network: []NetCounters{{Interface: "eth0", RxBytes: 4096}},
			Errors:  map[string]error{CollectorThermal: errBoom},
		},
		{
			Time: t0.Add(4 * time.Second),
			CPU:  &CPUStat{Total: CPUTimes{User: 10, Idle: 190}},
		},
	}}
	log, logs := newBufferLogger()
	s := NewSampler(src, time.Second, log)

	if _, ok := s.Latest(); ok {
		t.Fatal("Latest reported a sample before the first Collect")
	}
	counts := s.ErrorCounts()
	if len(counts) != len(Collectors) {
		t.Errorf("ErrorCounts has %d series, want one per collector (%d)", len(counts), len(Collectors))
	}

	ctx := context.Background()
	s.Collect(ctx)
	s.Collect(ctx)
	got, ok := s.Latest()
	if !ok {
		t.Fatal("no sample after Collect")
	}
	if got.Snapshot.CPU.UsagePercent != 10 {
		t.Errorf("UsagePercent = %v, want 10 (delta between samples)", got.Snapshot.CPU.UsagePercent)
	}
	if r := got.Snapshot.Network[0].RxBytesPerSecond; r != 2048 {
		t.Errorf("RxBytesPerSecond = %v, want 2048", r)
	}
	if n := s.ErrorCounts()[CollectorThermal]; n != 2 {
		t.Errorf("thermal errors = %d, want 2", n)
	}

	s.Collect(ctx)
	if got, _ := s.Latest(); got.Snapshot.CPU.UsagePercent != 0 {
		t.Errorf("UsagePercent = %v, want 0 for an idle interval", got.Snapshot.CPU.UsagePercent)
	}

	out := logs.String()
	if n := strings.Count(out, "collector failed"); n != 1 {
		t.Errorf("logged failure %d times, want once:\n%s", n, out)
	}
	if !strings.Contains(out, "collector recovered") {
		t.Errorf("recovery not logged:\n%s", out)
	}
}

func TestSamplerRun(t *testing.T) {
	src := &scriptedSource{readings: []Reading{{Time: time.Now()}}}
	log, _ := newBufferLogger()
	s := NewSampler(src, 5*time.Millisecond, log)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		s.Run(ctx)
		close(done)
	}()

	// Read concurrently with the sampling goroutine; -race checks the locking.
	deadline := time.After(5 * time.Second)
	for {
		src.mu.Lock()
		calls := src.calls
		src.mu.Unlock()
		if calls >= 3 {
			break
		}
		s.Latest()
		s.ErrorCounts()
		select {
		case <-deadline:
			t.Fatal("sampler did not tick")
		case <-time.After(time.Millisecond):
		}
	}
	if _, ok := s.Latest(); !ok {
		t.Error("no sample published")
	}

	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after cancel")
	}
}
