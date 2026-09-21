#!/usr/bin/env bash
#
# Build the Uno game image and push it to GitHub Container Registry (GHCR).
#
# Usage:
#   scripts/push-image.sh                       # build + push (tags: latest + git sha)
#   PUSH=0 scripts/push-image.sh                # build only, don't push
#   TAGS="v1.0.0,latest" scripts/push-image.sh  # custom tags (comma-separated)
#   IMAGE=ghcr.io/other/repo scripts/push-image.sh
#
# Authentication (one of):
#   export GITHUB_TOKEN=<a token with "packages: write" scope>
#   # — or —
#   docker login ghcr.io
#
set -euo pipefail
cd "$(dirname "$0")/.."

# --- configuration (all overridable via environment) ----------------------
REGISTRY="${REGISTRY:-ghcr.io}"
OWNER="${IMAGE_OWNER:-ufz0}"
REPO="${IMAGE_REPO:-uno-game}"
IMAGE="${IMAGE:-$REGISTRY/$OWNER/$REPO}"

SHA="$(git rev-parse --short HEAD 2>/dev/null || echo local)"
if [[ -n "${TAGS:-}" ]]; then
  IFS=',' read -r -a TAG_LIST <<< "$TAGS"
else
  TAG_LIST=("latest" "$SHA")
fi
PUSH="${PUSH:-1}"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

# --- preconditions ---------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker is not installed or not on PATH" >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "error: cannot reach the docker daemon (is Docker running?)" >&2
  exit 1
fi

# --- build -----------------------------------------------------------------
TAG_ARGS=()
for t in "${TAG_LIST[@]}"; do TAG_ARGS+=(-t "$IMAGE:$t"); done
log "Building $IMAGE  [${TAG_LIST[*]}]"
docker build "${TAG_ARGS[@]}" .

# --- push ------------------------------------------------------------------
if [[ "$PUSH" != "1" ]]; then
  log "PUSH=0 → build only, skipping push"
  exit 0
fi

TOKEN="${GHCR_TOKEN:-${DOCKER_TOKEN:-${GITHUB_TOKEN:-}}}"
if [[ -n "$TOKEN" ]]; then
  log "Logging in to $REGISTRY (token from environment)"
  printf '%s' "$TOKEN" | docker login "$REGISTRY" -u "${GITHUB_USER:-$OWNER}" --password-stdin
elif [[ -f "${HOME}/.docker/config.json" ]] && grep -q "$REGISTRY" "${HOME}/.docker/config.json"; then
  log "No token in environment; using the existing $REGISTRY login"
else
  echo "error: no GITHUB_TOKEN/GHCR_TOKEN set, and no existing $REGISTRY login found." >&2
  echo "       either:  export GITHUB_TOKEN=<a token with 'packages: write'>" >&2
  echo "                or:    docker login $REGISTRY" >&2
  exit 1
fi

for t in "${TAG_LIST[@]}"; do
  log "Pushing $IMAGE:$t"
  docker push "$IMAGE:$t"
done

log "Done. $IMAGE  [${TAG_LIST[*]}]"
