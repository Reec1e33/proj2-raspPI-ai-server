#!/usr/bin/env bash
# Download a model into the stack's Ollama service.
#
# Usage: pull-model.sh [MODEL]
#   MODEL  Ollama model tag. Default: PICLOUD_OLLAMA_MODEL from deploy/.env,
#          else llama3.2:1b (the api's default).
#
# Needs the `ollama` compose profile (COMPOSE_PROFILES=ollama in deploy/.env).
# Models persist in the ollama-models volume. Sizes: llama3.2:1b ~1.3 GB,
# llama3.2:3b ~2.0 GB; prefer 1b on a 4 GB Pi.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly DEPLOY_DIR
readonly DEFAULT_MODEL="llama3.2:1b"

die() {
  echo "error: $*" >&2
  exit 1
}

# Print the value of KEY from deploy/.env (empty when absent).
env_value() {
  [[ -f "$DEPLOY_DIR/.env" ]] || return 0
  sed -n "s/^$1=//p" "$DEPLOY_DIR/.env" | tail -n 1 | tr -d "\"'"
}

usage() {
  # Print the header comment: line 2 up to the first line that is not a comment.
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"
  exit "${1:-0}"
}

compose() {
  docker compose --project-directory "$DEPLOY_DIR" -f "$DEPLOY_DIR/docker-compose.yml" --profile ollama "$@"
}

case "${1:-}" in
  -h | --help) usage ;;
esac

model="${1:-$(env_value PICLOUD_OLLAMA_MODEL)}"
model="${model:-$DEFAULT_MODEL}"

if ! compose ps --status running --services | grep -qx ollama; then
  die "the ollama service is not running. Start it with: docker compose --profile ollama up -d ollama"
fi

echo "Pulling $model into Ollama..."
compose exec -T ollama ollama pull "$model"
compose exec -T ollama ollama list
