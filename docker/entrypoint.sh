#!/bin/sh
# Run the gateway under tini when the image has it, and directly when it does
# not. Compose sets `init: true`, so Docker's own init reaps children either
# way; this only avoids hard-coding a path that some base images lack.
set -eu

if [ -x /usr/bin/tini ]; then
  exec /usr/bin/tini -- "$@"
elif command -v tini >/dev/null 2>&1; then
  exec tini -- "$@"
fi

exec "$@"
