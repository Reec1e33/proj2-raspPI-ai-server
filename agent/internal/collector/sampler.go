package collector

import (
	"context"
	"log/slog"
	"maps"
	"sync"
	"time"
)

// Sampler polls a Source on a fixed interval and keeps the latest Sample.
// Latest and ErrorCounts are safe for concurrent use.
type Sampler struct {
	source   Source
	interval time.Duration
	log      *slog.Logger

	// Owned by the goroutine that calls Collect.
	prev    *Reading
	failing map[string]bool

	mu     sync.RWMutex
	latest Sample
	ok     bool
	errors map[string]uint64
}

// NewSampler returns a Sampler. Call Run to start it.
func NewSampler(source Source, interval time.Duration, log *slog.Logger) *Sampler {
	errs := make(map[string]uint64, len(Collectors))
	for _, name := range Collectors {
		errs[name] = 0 // export every series from the start so rate() works
	}
	return &Sampler{
		source:   source,
		interval: interval,
		log:      log,
		failing:  map[string]bool{},
		errors:   errs,
	}
}

// Run collects immediately and then on every tick until ctx is done.
func (s *Sampler) Run(ctx context.Context) {
	s.Collect(ctx)
	t := time.NewTicker(s.interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.Collect(ctx)
		}
	}
}

// Collect takes one reading and publishes a new Sample. It is not safe to
// call concurrently with itself; Run is the normal caller.
func (s *Sampler) Collect(ctx context.Context) {
	r := s.source.Read(ctx)
	sample := BuildSample(s.prev, r)
	s.prev = &r

	s.mu.Lock()
	s.latest, s.ok = sample, true
	for name, err := range r.Errors {
		if err != nil {
			s.errors[name]++
		}
	}
	s.mu.Unlock()

	s.logTransitions(r.Errors)
}

// logTransitions logs a collector once when it starts failing and once when
// it recovers, so a persistent fault does not flood the log every interval.
func (s *Sampler) logTransitions(errs map[string]error) {
	for _, name := range Collectors {
		err := errs[name]
		switch {
		case err != nil && !s.failing[name]:
			s.failing[name] = true
			s.log.Warn("collector failed", "collector", name, "error", err.Error())
		case err != nil:
			s.log.Debug("collector still failing", "collector", name, "error", err.Error())
		case s.failing[name]:
			delete(s.failing, name)
			s.log.Info("collector recovered", "collector", name)
		}
	}
}

// Latest returns the most recent Sample, and false if none exists yet. The
// Sample shares slices with the Sampler; callers must not modify it.
func (s *Sampler) Latest() (Sample, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.latest, s.ok
}

// ErrorCounts returns the number of failed reads per collector.
func (s *Sampler) ErrorCounts() map[string]uint64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return maps.Clone(s.errors)
}
