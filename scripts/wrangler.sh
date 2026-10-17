#!/usr/bin/env bash
# Runs the project's wrangler with a scoped Cloudflare API token from the macOS keychain, so no broad `wrangler login`
# token has to live on disk. Store the token once with:
#   security add-generic-password -a "$USER" -s cloudflare-claude-memory -w
# CLOUDFLARE_API_TOKEN already set, no keychain item, or not macOS: runs wrangler unchanged (its own login).
# CMC_KEYCHAIN_SERVICE overrides the keychain item's service name.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]] && command -v security >/dev/null 2>&1; then
  if token="$(security find-generic-password -s "${CMC_KEYCHAIN_SERVICE:-cloudflare-claude-memory}" -w 2>/dev/null)"; then
    export CLOUDFLARE_API_TOKEN="$token"
  fi
fi
exec "$here/../node_modules/.bin/wrangler" "$@"
