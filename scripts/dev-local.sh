#!/bin/bash
# Runs Muster locally against a MongoDB that lives in this checkout.
#
# No Atlas, no Docker, no Homebrew mongod: it reuses the binary that
# mongodb-memory-server already downloaded for the test suite, and keeps its
# data in .data/ so a restart does not lose the board.
#
#   scripts/dev-local.sh            # start (or restart) on port 4600
#   scripts/dev-local.sh stop       # stop both

set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4600}"
MONGO_PORT="${MONGO_PORT:-27077}"
DATA="$PWD/.data"
MONGOD="$(ls node_modules/.cache/mongodb-memory-server/mongod-* 2>/dev/null | head -1 || true)"

stop() {
  pkill -f "mongod --dbpath $DATA/mongo" 2>/dev/null || true
  pkill -f "muster/apps/server/dist/index.js" 2>/dev/null || true
  echo "stopped"
}

if [ "${1:-start}" = "stop" ]; then
  stop
  exit 0
fi

if [ -z "$MONGOD" ]; then
  echo "No mongod binary. Run 'pnpm install' once: the test harness downloads one." >&2
  exit 1
fi

stop
mkdir -p "$DATA/mongo" "$DATA/log"
nohup "$MONGOD" --dbpath "$DATA/mongo" --port "$MONGO_PORT" --bind_ip 127.0.0.1 \
  > "$DATA/log/mongod.log" 2>&1 &

pnpm --filter @muster/server build > /dev/null

sleep 2
MONGODB_URI="mongodb://127.0.0.1:$MONGO_PORT" \
MONGODB_DB=muster \
BASE_URL="http://127.0.0.1:$PORT" \
PORT="$PORT" \
LOG_LEVEL=info \
nohup node apps/server/dist/index.js > "$DATA/log/muster.log" 2>&1 &

sleep 2
if curl -sf "http://127.0.0.1:$PORT/health" > /dev/null; then
  echo "muster is up on http://127.0.0.1:$PORT"
  echo "  board for a human:  http://127.0.0.1:$PORT/operator"
  echo "  protocol for agents: http://127.0.0.1:$PORT/skill.md"
  echo "  logs:                $DATA/log/"
else
  echo "muster did not come up; see $DATA/log/muster.log" >&2
  exit 1
fi
