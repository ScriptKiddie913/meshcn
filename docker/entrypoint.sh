#!/bin/sh
set -e

HS_DIR="/opt/render/project/src/data/tor/hs"
mkdir -p "$HS_DIR"

# Restore onion keys from environment if provided (Addendum 8)
if [ -n "$TOR_HS_SECRET_KEY_BASE64" ]; then
  echo "$TOR_HS_SECRET_KEY_BASE64" | base64 -d > "$HS_DIR/hs_ed25519_secret_key"
fi
if [ -n "$TOR_HS_HOSTNAME" ]; then
  echo "$TOR_HS_HOSTNAME" > "$HS_DIR/hostname"
fi

chown -R debian-tor:debian-tor /opt/render/project/src/data/tor
chmod 700 "$HS_DIR"

# Start Tor daemon
su -s /bin/sh debian-tor -c "tor -f /etc/tor/torrc" &

# Wait for Tor to publish hostname
for i in $(seq 1 30); do
  if [ -f "$HS_DIR/hostname" ]; then
    ONION_ADDR=$(cat "$HS_DIR/hostname")
    echo "[sdmesh-tor] v3 Onion Service ready: $ONION_ADDR"
    break
  fi
  sleep 1
done

# Start Node server (Public :$PORT serves only /health, internal 127.0.0.1:3001 serves API/WS)
exec node server.js
