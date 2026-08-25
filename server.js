"use strict";

require("dotenv").config();

const http = require("http");
const express = require("express");
const cors = require("cors");

const healthRoute = require("./src/routes/health");
const registerRoute = require("./src/routes/register");
const syncRoute = require("./src/routes/sync");
const { attach: attachWs } = require("./src/ws");
const keepalive = require("./src/keepalive");

const app = express();

app.use(cors());
app.disable("x-powered-by");

// Headless: no web UI. Machine-oriented endpoints only.
app.use(healthRoute);
app.use(registerRoute);
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
  console.error("[sdmesh] error:", err);
  res.status(500).json({ error: "internal_error" });
});

const server = http.createServer(app);
attachWs(server);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[sdmesh] mesh server listening on :${PORT}`);
  keepalive.start(PORT);
});
