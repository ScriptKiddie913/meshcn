"use strict";

const { WebSocketServer, WebSocket } = require("ws");
const { verifyToken } = require("./auth");
const { touch, nodeIdTaken } = require("./registry");
const { appendEvent } = require("./events");
const {
  storeMailboxItem,
  ackMailboxItems,
  nodeOwnsMailbox,
  registerNodeMailbox,
} = require("./mailbox");

const NODE_ID_RE = /^[a-zA-Z0-9._-]{4,128}$/;
const MAX_CIPHERTEXT_LEN = 48 * 1024; // 48 KiB
const MAX_WS_PAYLOAD = 64 * 1024;    // 64 KiB
const PING_INTERVAL_MS = 25_000;

// node_id -> ws connection
const connections = new Map();
// mailbox_id -> Set of ws connections
const mailboxSubscribers = new Map();
let pingInterval = null;

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

/** Push a message to subscribers of a mailbox (S1: no global broadcast). */
function pushToMailbox(mailboxId, item) {
  const subs = mailboxSubscribers.get(mailboxId);
  if (subs) {
    for (const ws of subs) {
      send(ws, {
        type: "mailbox_item",
        mailbox_id: mailboxId,
        msg_id: item.msg_id,
        envelope: item.envelope,
      });
    }
  }
}

function isOnline(nodeId) {
  return connections.has(nodeId);
}

class TokenBucket {
  constructor(capacity = 20, fillRatePerSec = 5) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.fillRate = fillRatePerSec;
    this.lastFill = Date.now();
  }

  take() {
    const now = Date.now();
    const elapsedSec = (now - this.lastFill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.fillRate);
    this.lastFill = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

function extractAuth(req) {
  const authHeader = req.headers["authorization"] || "";
  let token = null;
  if (authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7).trim();
  }
  const nodeId = req.headers["x-node-id"] || null;
  return { nodeId, token };
}

function attach(httpServer) {
  const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws",
    maxPayload: MAX_WS_PAYLOAD,
  });

  // Heartbeat watchdog: detect and prune stale/dead sockets
  pingInterval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, PING_INTERVAL_MS);

  if (pingInterval.unref) pingInterval.unref();

  wss.on("connection", (ws, req) => {
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    const { nodeId, token } = extractAuth(req);

    // Reject unauthenticated connections (S10)
    if (!nodeId || !token || !verifyToken(nodeId, token)) {
      send(ws, { type: "error", error: "unauthorized" });
      ws.close(4001, "unauthorized");
      return;
    }

    const limiter = new TokenBucket(20, 5);
    const mySubscribedMailboxes = new Set();

    // A given node may only hold one active connection at a time.
    const existing = connections.get(nodeId);
    if (existing && existing !== ws) {
      existing.close(4002, "replaced_by_new_connection");
    }
    connections.set(nodeId, ws);
    touch(nodeId);

    // Connected acknowledgment (S3: global peers list removed)
    send(ws, { type: "connected", node_id: nodeId, v: 2 });

    ws.on("message", (raw) => {
      // Per-session rate limiter check
      if (!limiter.take()) {
        return send(ws, { type: "error", error: "rate_limited" });
      }

      let msg;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        return send(ws, { type: "error", error: "invalid_json" });
      }

      if (!msg || typeof msg !== "object" || !msg.type) {
        return send(ws, { type: "error", error: "invalid_payload" });
      }

      touch(nodeId);

      switch (msg.type) {
        case "heartbeat": {
          send(ws, { type: "heartbeat_ack", ts: Date.now() });
          break;
        }

        // Phase 1 Mailbox Subscription (S1)
        case "mailbox_subscribe": {
          const mailboxId = msg.mailbox_id;
          if (!mailboxId || typeof mailboxId !== "string") {
            return send(ws, { type: "error", error: "invalid_mailbox_id" });
          }

          // Register node ownership capability if new
          registerNodeMailbox(nodeId, mailboxId);
          mySubscribedMailboxes.add(mailboxId);

          if (!mailboxSubscribers.has(mailboxId)) {
            mailboxSubscribers.set(mailboxId, new Set());
          }
          mailboxSubscribers.get(mailboxId).add(ws);

          send(ws, { type: "mailbox_subscribed", mailbox_id: mailboxId });
          break;
        }

        // Phase 1 Mailbox Deposit (S1, S8)
        case "mailbox_put": {
          const { mailbox_id: mailboxId, msg_id: msgId, envelope } = msg;
          if (!mailboxId || !msgId || !envelope) {
            return send(ws, { type: "error", error: "invalid_mailbox_fields" });
          }

          const result = storeMailboxItem({
            mailboxId,
            msgId: String(msgId),
            envelope,
          });

          send(ws, {
            type: "mailbox_stored",
            mailbox_id: mailboxId,
            msg_id: msgId,
            inserted: result.inserted,
          });

          if (result.inserted) {
            pushToMailbox(mailboxId, { msg_id: msgId, envelope });
          }
          break;
        }

        // Phase 1 Mailbox Ack/Deletion (S7)
        case "mailbox_ack": {
          const { mailbox_id: mailboxId, msg_ids: msgIds } = msg;
          if (!mailboxId || !Array.isArray(msgIds)) {
            return send(ws, { type: "error", error: "invalid_ack_fields" });
          }

          if (nodeOwnsMailbox(nodeId, mailboxId)) {
            const count = ackMailboxItems(mailboxId, msgIds);
            send(ws, { type: "mailbox_acked", mailbox_id: mailboxId, count });
          }
          break;
        }

        // Legacy direct message routing (backward compatibility)
        case "message": {
          const targetNodeId = msg.target_node_id;
          const ciphertext = msg.ciphertext;
          const clientEventId = msg.client_event_id;

          if (
            typeof targetNodeId !== "string" ||
            !NODE_ID_RE.test(targetNodeId) ||
            typeof ciphertext !== "string" ||
            ciphertext.length === 0 ||
            ciphertext.length > MAX_CIPHERTEXT_LEN
          ) {
            return send(ws, { type: "error", error: "invalid_message_fields" });
          }

          if (!nodeIdTaken(targetNodeId)) {
            return send(ws, { type: "error", error: "unknown_target" });
          }

          const eventRow = appendEvent({
            nodeId,
            eventType: "MESSAGE_CREATED",
            payload: { target_node_id: targetNodeId, ciphertext },
            signature: typeof msg.signature === "string" ? msg.signature : null,
            clientEventId: typeof clientEventId === "string" ? clientEventId : null,
          });

          send(ws, {
            type: "message_stored",
            client_event_id: eventRow.client_event_id,
            global_seq: eventRow.global_seq,
            inserted: eventRow.inserted,
          });

          if (eventRow.inserted) {
            const target = connections.get(targetNodeId);
            if (target) {
              send(target, {
                type: "message",
                from: nodeId,
                ciphertext,
                global_seq: eventRow.global_seq,
                client_event_id: eventRow.client_event_id,
              });
              send(ws, {
                type: "message_delivered",
                target_node_id: targetNodeId,
                client_event_id: eventRow.client_event_id,
                global_seq: eventRow.global_seq,
              });
            } else {
              send(ws, {
                type: "message_queued",
                target_node_id: targetNodeId,
                client_event_id: eventRow.client_event_id,
                global_seq: eventRow.global_seq,
              });
            }
          }
          break;
        }

        default:
          send(ws, { type: "error", error: "unknown_message_type" });
      }
    });

    ws.on("close", () => {
      if (connections.get(nodeId) === ws) {
        connections.delete(nodeId);
      }
      for (const mbxId of mySubscribedMailboxes) {
        const subs = mailboxSubscribers.get(mbxId);
        if (subs) {
          subs.delete(ws);
          if (subs.size === 0) mailboxSubscribers.delete(mbxId);
        }
      }
    });
  });

  return wss;
}

function closeAll() {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
  for (const [nodeId, ws] of connections.entries()) {
    try {
      send(ws, { type: "server_restarting" });
      ws.close(1001, "server_restarting");
    } catch {}
  }
  connections.clear();
  mailboxSubscribers.clear();
}

module.exports = { attach, isOnline, closeAll };
