VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)
IMAGE   ?= picloud-agent
STATICCHECK_VERSION ?= 2026.2.2

.PHONY: all build test cover lint cross run-demo docker clean

all: lint test build

build: ## Build bin/pi-agent for this machine
	CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o bin/pi-agent ./cmd/pi-agent

test: ## Run tests with the race detector
	go test -race -cover ./...

cover: ## Write coverage.out and print the total
	go test -coverprofile=coverage.out ./...
	go tool cover -func=coverage.out | tail -n 1

lint: ## gofmt, go vet and staticcheck
	@out="$$(gofmt -l .)"; if [ -n "$$out" ]; then echo "gofmt needed:"; echo "$$out"; exit 1; fi
	go vet ./...
	go run honnef.co/go/tools/cmd/staticcheck@$(STATICCHECK_VERSION) ./...

cross: ## Check that the Raspberry Pi targets compile
	GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o /dev/null ./cmd/pi-agent
	GOOS=linux GOARCH=arm GOARM=7 CGO_ENABLED=0 go build -o /dev/null ./cmd/pi-agent

run-demo: ## Serve synthetic data on 127.0.0.1:9110
	go run ./cmd/pi-agent -demo -listen 127.0.0.1:9110

docker: ## Build the container image for this machine
	docker build --build-arg VERSION=$(VERSION) -t $(IMAGE):$(VERSION) .

clean:
	rm -rf bin coverage.out
