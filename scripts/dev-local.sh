#!/bin/bash
# Runs Muster locally against a MongoDB that lives in this checkout.
#
# No Atlas, no Docker, no Homebrew mongod: it reuses the binary that
# mongodb-memory-server already downloaded for the test suite, and keeps its
# data in .data/ so a restart does not lose the board.
#
# It binds to localhost and raises the published limits, because they exist to
# slow down strangers and there are none here. The soak tool in particular is
# meant to hammer this instance, and throttling it just measures the throttle.
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
  # Kill by port, not by command line. The server is started with a relative
  # path, so a pattern written against the absolute one silently matches
  # nothing, the old process keeps the port, and the new one dies on bind while
  # the stale build carries on answering. That cost half an hour once.
  lsof -ti "tcp:$PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true
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

pnpm --filter @muster/server build

sleep 2
MONGODB_URI="mongodb://127.0.0.1:$MONGO_PORT" \
MONGODB_DB=muster \
BASE_URL="http://127.0.0.1:$PORT" \
PORT="$PORT" \
HOST=127.0.0.1 \
LOG_LEVEL=info \
LIMIT_CREATE_PROJECTS_PER_HOUR="${LIMIT_CREATE_PROJECTS_PER_HOUR:-100}" \
LIMIT_WRITES_PER_MINUTE="${LIMIT_WRITES_PER_MINUTE:-6000}" \
LIMIT_READS_PER_MINUTE="${LIMIT_READS_PER_MINUTE:-6000}" \
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
