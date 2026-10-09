"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

let serverKeypair = null;
let serverEpoch = crypto.randomBytes(16).toString("hex");

function initServerIdentity(keyPemOrDir = null) {
  // If provided directly via env
  const envKey = process.env.SERVER_IDENTITY_KEY;
  if (envKey) {
    serverKeypair = {
      privateKey: crypto.createPrivateKey(envKey),
      publicKey: crypto.createPublicKey(envKey),
    };
    return;
  }

  // Check file in data directory
  const keyPath = path.join(__dirname, "../data/server_identity.key");
  if (fs.existsSync(keyPath)) {
    const pem = fs.readFileSync(keyPath, "utf8");
    serverKeypair = {
      privateKey: crypto.createPrivateKey(pem),
      publicKey: crypto.createPublicKey(pem),
    };
    return;
  }

  // Generate ephemeral key for development/test if not in production
  const kp = crypto.generateKeyPairSync("ed25519");
  serverKeypair = {
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
  };
}

initServerIdentity();

function getServerEpoch() {
  return serverEpoch;
}

function resetServerEpoch() {
  serverEpoch = crypto.randomBytes(16).toString("hex");
  return serverEpoch;
}

function getServerPublicKeySpkiBase64() {
  return serverKeypair.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64");
}

function signHandshakeChallenge(nonce, host) {
  const data = `sdmesh-handshake-v2|${nonce}|${serverEpoch}|${host}`;
  const sig = crypto.sign(null, Buffer.from(data, "utf8"), serverKeypair.privateKey);
  return {
    epoch: serverEpoch,
    server_sig: sig.toString("base64"),
    server_pub: getServerPublicKeySpkiBase64(),
  };
}

function issueRegistrationReceipt(userId, username) {
  const issuedAt = Date.now();
  const data = `sdmesh-receipt-v2|${userId}|${username}|${issuedAt}`;
  const sig = crypto.sign(null, Buffer.from(data, "utf8"), serverKeypair.privateKey);
  return {
    user_id: userId,
    username,
    issued_at: issuedAt,
    signature: sig.toString("base64"),
  };
}

function verifyRegistrationReceipt(receipt, serverPubBase64 = null) {
  if (!receipt || !receipt.user_id || !receipt.username || !receipt.issued_at || !receipt.signature) {
    return false;
  }
  const data = `sdmesh-receipt-v2|${receipt.user_id}|${receipt.username}|${receipt.issued_at}`;
  const pub = serverPubBase64
    ? crypto.createPublicKey({ key: Buffer.from(serverPubBase64, "base64"), format: "der", type: "spki" })
    : serverKeypair.publicKey;

  try {
    return crypto.verify(
      null,
      Buffer.from(data, "utf8"),
      pub,
      Buffer.from(receipt.signature, "base64")
    );
  } catch {
    return false;
  }
}

function signManifest(validUntil, onionAddresses) {
  const data = `sdmesh-manifest-v2|${validUntil}|${onionAddresses.join(",")}`;
  const sig = crypto.sign(null, Buffer.from(data, "utf8"), serverKeypair.privateKey);
  return {
    valid_until: validUntil,
    onion_addresses: onionAddresses,
    signature: sig.toString("base64"),
  };
}

module.exports = {
  getServerEpoch,
  resetServerEpoch,
  getServerPublicKeySpkiBase64,
  signHandshakeChallenge,
  issueRegistrationReceipt,
  verifyRegistrationReceipt,
  signManifest,
};
