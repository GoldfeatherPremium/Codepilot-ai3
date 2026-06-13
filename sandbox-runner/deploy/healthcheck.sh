#!/usr/bin/env bash
# Cron healthcheck: restarts the runner stack if /healthz fails twice in a row.
# State lives in /run so a single transient blip never triggers a restart.
set -u
STATE=/run/codepilot-healthcheck.fails
URL="http://127.0.0.1:8080/healthz"

if curl -fsS --max-time 5 "$URL" | grep -q '"ok":true'; then
  rm -f "$STATE"
  exit 0
fi

FAILS=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 ))
echo "$FAILS" > "$STATE"
logger -t codepilot-healthcheck "healthz failed (${FAILS}x)"

if [ "$FAILS" -ge 2 ]; then
  logger -t codepilot-healthcheck "restarting runner stack"
  systemctl restart codepilot-runner.service || {
    cd "$(systemctl show -p WorkingDirectory codepilot-runner.service | cut -d= -f2)" && docker compose restart
  }
  rm -f "$STATE"
fi
