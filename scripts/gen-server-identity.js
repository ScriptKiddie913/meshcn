#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const keypair = crypto.generateKeyPairSync("ed25519");
const priv = keypair.privateKey.export({ type: "pkcs8", format: "pem" });
const pub = keypair.publicKey.export({ type: "spki", format: "pem" });
const pubDer = keypair.publicKey.export({ type: "spki", format: "der" }).toString("base64");

const outDir = process.argv[2] || path.join(__dirname, "../data");
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

fs.writeFileSync(path.join(outDir, "server_identity.key"), priv, { mode: 0o600 });
fs.writeFileSync(path.join(outDir, "server_identity.pub"), pub, { mode: 0o644 });

console.log("Server identity keypair generated:");
console.log(`Private: ${path.join(outDir, "server_identity.key")}`);
console.log(`Public:  ${path.join(outDir, "server_identity.pub")}`);
console.log(`Public Base64 SPKI:\n${pubDer}`);
