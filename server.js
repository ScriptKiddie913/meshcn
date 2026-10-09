"use strict";

require("dotenv").config();

const http = require("http");
const express = require("express");

const db = require("./src/db");
const healthRoute = require("./src/routes/health");
const registerRoute = require("./src/routes/register");
const authRoute = require("./src/routes/auth");
const mailboxRoute = require("./src/routes/mailbox");
const syncRoute = require("./src/routes/sync");
const { attach: attachWs, closeAll: closeAllWs } = require("./src/ws");

const app = express();

app.disable("x-powered-by");

// Basic security headers (S13)
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "default-src 'none'");
  next();
});

// Headless: no web UI. Machine-oriented endpoints only.
app.use(healthRoute);
app.use(registerRoute);
app.use(authRoute);
app.use(mailboxRoute);
app.use(syncRoute);

// Explicitly no dashboard at "/".
app.get("/", (req, res) => {
  res.status(404).json({ error: "no_ui", hint: "this is a headless mesh API; see /health" });
});

app.use((req, res) => {
  res.status(404).json({ error: "not_found" });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("[sdmesh error]", err && err.message ? err.message : err);
  res.status(500).json({ error: "internal_error" });
});

const server = http.createServer(app);
const wss = attachWs(server);

let isShuttingDown = false;

function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  // Drain WebSockets (S12)
  try {
    closeAllWs();
    wss.close();
  } catch {}

  server.close(() => {
    try {
      // Checkpoint WAL and close DB (S12)
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      db.close();
    } catch {}
    process.exit(0);
  });

  // Force close after 5s if still hanging
  setTimeout(() => {
    process.exit(1);
  }, 5000).unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  console.error("[sdmesh] unhandledRejection:", reason && reason.message ? reason.message : reason);
});

process.on("uncaughtException", (err) => {
  console.error("[sdmesh] uncaughtException:", err.message);
  gracefulShutdown("uncaughtException");
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  if (process.env.API_BIND) {
    const parts = process.env.API_BIND.split(":");
    const bindHost = parts[0] || "127.0.0.1";
    const bindPort = Number(parts[1]) || 3001;

    // Internal server for Tor onion service
    server.listen(bindPort, bindHost, () => {
      console.log(`[sdmesh] hidden service API bound to ${bindHost}:${bindPort}`);
    });

    // Minimal public server on Render's $PORT for /health check only
    const healthApp = express();
    healthApp.disable("x-powered-by");
    healthApp.get("/health", (req, res) => res.json({ status: "ok" }));
    healthApp.use((req, res) => res.status(404).json({ error: "not_found" }));
    const publicServer = http.createServer(healthApp);
    publicServer.listen(PORT, () => {
      console.log(`[sdmesh] public health check listening on :${PORT}`);
    });
  } else {
    server.listen(PORT, () => {
      console.log(`[sdmesh] mesh server listening on :${PORT}`);
    });
  }
}

module.exports = { app, server, db };
