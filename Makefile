# PiCloud: one entry point for the tool chain of each component.
# `make check` runs the lint and test steps of .github/workflows/ci.yml.
# Tools: Go, uv, pnpm (Corepack), Docker Compose >= 2.24.4, ShellCheck, jq, Bash >= 4.4.

SHELL := bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help
MAKEFLAGS += --no-print-directory

GOVULNCHECK_VERSION := v1.9.0
SHELL_SCRIPTS := infra/bootstrap.sh infra/verify.sh \
	$(wildcard infra/lib/*.sh infra/modules/*.sh infra/tests/*.sh deploy/scripts/*.sh)
COMPOSE := docker compose -f deploy/docker-compose.yml --env-file deploy/.env.example
DEV_COMPOSE := docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.dev.yml
# Image of a compose service, so the checks use the exact tags that the stack runs.
image = $(shell $(COMPOSE) config --format json | jq -r '.services["$(1)"].image')

##@ General

.PHONY: help
help: ## Show this help
	@awk 'BEGIN { FS = ":.*## " } \
		/^##@/ { printf "\n%s\n", substr($$0, 5) } \
		/^[a-zA-Z0-9_-]+:.*## / { printf "  \033[36m%-13s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

.PHONY: setup
setup: ## Install the dependencies of agent/, api/ and web/
	cd agent && go mod download
	cd api && uv sync --locked
	cd web && pnpm install --frozen-lockfile

.PHONY: check lint test
check: lint test ## Run every lint and test (CI without the e2e stack)
lint: agent-lint api-lint web-lint shell-lint deploy-lint ## Run every linter
test: agent-test api-test web-test infra-test deploy-test ## Run every test suite

.PHONY: build
build: agent-build web-build ## Build bin/pi-agent and web/dist

.PHONY: vuln
vuln: ## Scan the agent with govulncheck (CI pins Go 1.27.3)
	cd agent && go run golang.org/x/vuln/cmd/govulncheck@$(GOVULNCHECK_VERSION) ./...

##@ Components

.PHONY: agent-lint agent-test agent-build
agent-lint: ## agent: gofmt, go mod tidy -diff, go vet, staticcheck
	$(MAKE) -C agent lint
	cd agent && go mod tidy -diff
agent-test: ## agent: go test -race
	$(MAKE) -C agent test
agent-build: ## agent: bin/pi-agent and the Raspberry Pi cross-builds
	$(MAKE) -C agent build cross

.PHONY: api-lint api-test
api-lint: ## api: ruff check, ruff format --check, mypy --strict
	cd api && uv run ruff check && uv run ruff format --check && uv run mypy
api-test: ## api: pytest with the coverage gate
	cd api && uv run pytest

.PHONY: web-lint web-test web-build
web-lint: ## web: eslint, tsc, prettier --check
	cd web && pnpm lint && pnpm typecheck && pnpm format:check
web-test: ## web: vitest
	cd web && pnpm test --run
web-build: ## web: production build in web/dist
	cd web && pnpm build

.PHONY: shell-lint infra-test
shell-lint: ## infra and deploy scripts: shellcheck
	shellcheck -x -S style $(SHELL_SCRIPTS)
infra-test: ## infra: unit tests
	bash infra/tests/run.sh

.PHONY: deploy-lint deploy-test
deploy-lint: ## deploy: compose, Prometheus, Alloy, Loki and Grafana config
	$(COMPOSE) config --quiet
	$(COMPOSE) -f deploy/docker-compose.dev.yml config --quiet
	docker run --rm --entrypoint promtool -v "$(CURDIR)/deploy/prometheus:/etc/prometheus:ro" \
		-w /etc/prometheus $(call image,prometheus) check config prometheus.yml
	docker run --rm -v "$(CURDIR)/deploy/alloy:/etc/alloy:ro" $(call image,alloy) \
		fmt --test /etc/alloy/config.alloy
	docker run --rm -v "$(CURDIR)/deploy/alloy:/etc/alloy:ro" $(call image,alloy) \
		validate /etc/alloy/config.alloy
	docker run --rm -v "$(CURDIR)/deploy/loki:/etc/loki:ro" $(call image,loki) \
		-config.file=/etc/loki/config.yml -config.expand-env=true -verify-config
	for f in deploy/grafana/dashboards/*.json; do jq empty "$$f" || exit 1; done
deploy-test: ## deploy: Prometheus alert rule unit tests
	docker run --rm --entrypoint promtool -v "$(CURDIR)/deploy/prometheus:/etc/prometheus:ro" \
		-w /etc/prometheus $(call image,prometheus) test rules tests/picloud-alerts.test.yml

##@ Laptop stack (https://localhost:8443)

.PHONY: dev-init dev-up dev-down dev-logs smoke images
dev-init: ## Create deploy/.env, a self-signed certificate and a basic-auth user
	test -f deploy/.env || cp deploy/.env.example deploy/.env
	test -f deploy/nginx/certs/privkey.pem || deploy/scripts/gen-self-signed-cert.sh localhost
	test -f deploy/nginx/htpasswd || deploy/scripts/create-htpasswd.sh admin
dev-up: ## Build the images and start the stack (demo agent, no Ollama)
	$(DEV_COMPOSE) up --build --detach --wait
dev-down: ## Stop the stack and keep its volumes
	$(DEV_COMPOSE) down
dev-logs: ## Follow the logs of the stack
	$(DEV_COMPOSE) logs --follow --tail=100
smoke: ## Run the smoke test (set SMOKE_USER and SMOKE_PASSWORD)
	SMOKE_HTTP_URL=http://localhost:8080 deploy/scripts/smoke-test.sh https://localhost:8443
images: ## Build the agent, api and gateway images for this machine
	$(DEV_COMPOSE) build

##@ Housekeeping

.PHONY: clean
clean: ## Remove build output and coverage files (keeps dependencies)
	$(MAKE) -C agent clean
	rm -rf web/dist web/coverage api/.coverage api/htmlcov dist
