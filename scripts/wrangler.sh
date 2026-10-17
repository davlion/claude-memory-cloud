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
# wrangler.jsonc is the committed template; a git-ignored wrangler.local.jsonc holds this deployment's real URL, app slug
# and KV ids. Use it when it exists, unless the command names its own config.
root="$(cd "$here/.." && pwd)"
if [[ -f "$root/wrangler.local.jsonc" && " $* " != *" --config"* && " $* " != *" -c "* ]]; then
  (cd "$root" && node scripts/check-config.mjs)
  set -- "$@" --config "$root/wrangler.local.jsonc"
fi
exec "$root/node_modules/.bin/wrangler" "$@"
