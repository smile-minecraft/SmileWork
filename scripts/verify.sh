#!/usr/bin/env bash
set -euo pipefail

bun run typecheck

home_dir="${HOME:-}"
tmp_dir="${TMPDIR:-}"
if [[ -z "$tmp_dir" || -z "$home_dir" || "$tmp_dir" == "$home_dir" || "$tmp_dir" == "$home_dir"/* ]]; then
  TMPDIR=/tmp bun test
else
  bun test
fi

bun run build
