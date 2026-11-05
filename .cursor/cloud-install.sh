#!/usr/bin/env bash
set -euo pipefail

# Matches root package.json packageManager (pnpm 11.13.0) and engines.node (>=22).
corepack enable
corepack prepare pnpm@11.13.0 --activate

pnpm install --frozen-lockfile

if ! command -v strace >/dev/null 2>&1; then
  sudo apt-get update
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y strace
fi

python3 -m pip install --disable-pip-version-check --user \
  requests httpx aiohttp urllib3 build
