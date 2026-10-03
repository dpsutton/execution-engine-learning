#!/usr/bin/env bash
# Build every Go program (engine + lesson demos) to WebAssembly for docs/terminal.html.
# Output: docs/wasm/ (gitignored; CI builds it for Pages).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/docs/wasm"
mkdir -p "$out"
cd "$root/go"
for dir in cmd/*/; do
  name="$(basename "$dir")"
  GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o "$out/$name.wasm" "./$dir"
  echo "built $name.wasm ($(du -h "$out/$name.wasm" | cut -f1))"
done
# Go's loader must come from the same Go version as the compiler.
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$out/"
cp "$root/queries/golden.sql" "$out/"
