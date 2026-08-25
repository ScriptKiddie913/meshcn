"use strict";

const express = require("express");
const { currentGlobalSeq } = require("../events");

const router = express.Router();

router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "sdmesh",
    global_seq: currentGlobalSeq(),
  });
});

module.exports = router;
