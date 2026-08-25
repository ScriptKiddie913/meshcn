"use strict";

// Self-ping loop. Render (and similar hosts) spin a free-tier service down
// after a period of no inbound HTTP traffic. This keeps traffic flowing to
// ourselves so the service never sees an idle gap.
//
// Env vars:
//   KEEPALIVE_URL          full URL to ping (default: derived from RENDER_EXTERNAL_URL + /health)
//   KEEPALIVE_INTERVAL_MS  ping interval in ms (default: 40000 — stays under the 50s ask)

const DEFAULT_INTERVAL_MS = 40_000;

function resolveUrl(port) {
  if (process.env.KEEPALIVE_URL) return process.env.KEEPALIVE_URL;
  if (process.env.RENDER_EXTERNAL_URL) {
    return `${process.env.RENDER_EXTERNAL_URL.replace(/\/+$/, "")}/health`;
  }
  // Local fallback so this doesn't crash outside Render.
  return `http://127.0.0.1:${port}/health`;
}

function start(port) {
  const url = resolveUrl(port);
  const intervalMs = Number(process.env.KEEPALIVE_INTERVAL_MS) || DEFAULT_INTERVAL_MS;

  console.log(`[sdmesh] keepalive: pinging ${url} every ${intervalMs}ms`);

  const ping = async () => {
    try {
      const res = await fetch(url, { method: "GET" });
      if (!res.ok) {
        console.warn(`[sdmesh] keepalive: ping returned ${res.status}`);
      }
    } catch (err) {
      console.warn(`[sdmesh] keepalive: ping failed: ${err.message}`);
    }
  };

  // Fire once shortly after boot, then on a steady interval forever.
  const initial = setTimeout(ping, 5_000);
  const interval = setInterval(ping, intervalMs);

  // Don't let the keepalive timers themselves hold the process open in ways
  // that block a graceful shutdown.
  initial.unref?.();
  interval.unref?.();

  return () => {
    clearTimeout(initial);
    clearInterval(interval);
  };
}

module.exports = { start };
