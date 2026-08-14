#!/bin/bash
# Auto-restart loop for the app server. Detached from any controlling terminal.
cd "$(dirname "$0")"
while true; do
  echo "[$(date -Iseconds)] starting node server.js" >> /tmp/auto-service.log
  node server.js >> /tmp/auto-service.log 2>&1
  echo "[$(date -Iseconds)] server exited with code $?, restarting in 2s" >> /tmp/auto-service.log
  sleep 2
done
