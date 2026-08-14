#!/bin/bash
# Auto-restart loop for the cloudflare tunnel. Detached.
URL_LOG=/tmp/cf.log
echo "" > "$URL_LOG"
while true; do
  echo "[$(date -Iseconds)] starting cloudflared tunnel" >> /tmp/cf-tunnel.log
  /tmp/cloudflared tunnel --url http://localhost:3000 >> "$URL_LOG" 2>&1
  echo "[$(date -Iseconds)] cloudflared exited with $?, restarting in 2s" >> /tmp/cf-tunnel.log
  sleep 2
done
