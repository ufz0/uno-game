#!/usr/bin/env bash
#
# Build the Uno game image (multi-arch) and push it to GitHub Container Registry.
#
# Platforms: linux/amd64 (x86) + linux/arm64 (Apple Silicon / ARM). These are
# Linux images; on macOS, Docker runs them via the VM — arm64 on Apple
# Silicon, amd64 on Intel Macs — so the same image covers Linux and macOS.
#
# Usage:
#   scripts/push-image.sh                          # build + push (latest + git sha)
#   PUSH=0 scripts/push-image.sh                   # build only (single platform, local)
#   PLATFORMS=linux/amd64 scripts/push-image.sh    # restrict the target platforms
#   TAGS="v1.0.0,latest" scripts/push-image.sh     # custom tags (comma-separated)
#   IMAGE=ghcr.io/other/repo scripts/push-image.sh # override the image name
#
# Authentication (one of):
#   export GITHUB_TOKEN=<a token with "packages: write" scope>
#   export GHCR_TOKEN / DOCKER_TOKEN=<any token valid for the registry>
#   ...or run "docker login ghcr.io" once (we'll reuse that credential).
#
# Uses docker buildx, so both architectures are produced in a single build.

set -euo pipefail

cd "$(dirname "$0")/.."

REGISTRY="${REGISTRY:-ghcr.io}"
IMAGE_OWNER="${IMAGE_OWNER:-ufz0}"
IMAGE_REPO="${IMAGE_REPO:-uno-game}"
IMAGE="${IMAGE:-$REGISTRY/$IMAGE_OWNER/$IMAGE_REPO}"

# Architectures to build. Default: x86 (amd64) + arm (arm64).
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
PUSH="${PUSH:-1}"

SHA="$(git rev-parse --short HEAD 2>/dev/null || echo local)"
if [[ -n "${TAGS:-}" ]]; then
  IFS=',' read -r -a TAG_LIST <<< "$TAGS"
else
  TAG_LIST=( "latest" "$SHA" )
fi

command -v docker >/dev/null || { echo "docker CLI not found" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "docker daemon not running" >&2; exit 1; }
docker buildx version >/dev/null 2>&1 || { echo "docker buildx not available" >&2; exit 1; }

# Assemble the -t flags.
TAG_ARGS=()
for t in "${TAG_LIST[@]}"; do TAG_ARGS+=( -t "${IMAGE}:${t}" ); done

echo "==> Building ${IMAGE}  [platforms: ${PLATFORMS}]"

if [[ "$PUSH" == "1" ]]; then
  # --- authenticate (only needed when actually pushing) ---
  TOKEN="${GHCR_TOKEN:-${DOCKER_TOKEN:-${GITHUB_TOKEN:-}}}"
  if [[ -z "$TOKEN" ]]; then
    if grep -q "$REGISTRY" "$HOME/.docker/config.json" 2>/dev/null; then
      echo "==> using existing docker login for ${REGISTRY}"
    else
      echo "ERROR: no token found. Set GITHUB_TOKEN / GHCR_TOKEN (needs 'packages: write')" >&2
      echo "       or run: docker login $REGISTRY" >&2
      exit 1
    fi
  else
    USER_NAME="${GITHUB_USER:-${IMAGE_OWNER}}"
    echo "==> docker login $REGISTRY"
    printf '%s' "$TOKEN" | docker login "$REGISTRY" --username "$USER_NAME" --password-stdin
  fi

  # Multi-platform build + direct push (buildx handles the manifest list).
  docker buildx build \
    --platform "$PLATFORMS" \
    "${TAG_ARGS[@]}" \
    --push .

  echo
  echo "==> pushed:"
  for t in "${TAG_LIST[@]}"; do echo "     ${IMAGE}:${t}"; done
else
  # --load only supports a single platform, so build the first one locally.
  if [[ "$PLATFORMS" == *,* ]]; then
    FIRST="${PLATFORMS%%,*}"
    echo "==> PUSH=0 → build only, single platform (${FIRST})"
    docker buildx build --platform "$FIRST" "${TAG_ARGS[@]}" --load .
  else
    echo "==> PUSH=0 → build only"
    docker buildx build --platform "$PLATFORMS" "${TAG_ARGS[@]}" --load .
  fi
fi
