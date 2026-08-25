"use strict";

const { WebSocketServer } = require("ws");
const url = require("url");
const { verifyToken } = require("./auth");
const { touch, listPeers } = require("./registry");
const { appendEvent } = require("./events");

// node_id -> ws connection
const connections = new Map();

function send(ws, data) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

/** Push a message to every connected client except `excludeNodeId`. */
function broadcast(data, excludeNodeId = null) {
  for (const [nodeId, ws] of connections.entries()) {
    if (nodeId === excludeNodeId) continue;
    send(ws, data);
  }
}

function isOnline(nodeId) {
  return connections.has(nodeId);
}

function attach(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws, req) => {
    const { query } = url.parse(req.url, true);
    const nodeId = query.node_id;
    const token = query.token;

    if (!verifyToken(nodeId, token)) {
      send(ws, { type: "error", error: "unauthorized" });
      ws.close(4001, "unauthorized");
      return;
    }

    // A given node may only hold one active connection at a time.
    const existing = connections.get(nodeId);
    if (existing) existing.close(4002, "replaced_by_new_connection");
    connections.set(nodeId, ws);
    touch(nodeId);

    send(ws, { type: "connected", node_id: nodeId, peers: listPeers() });
    broadcast({ type: "presence", node_id: nodeId, status: "online" }, nodeId);

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(ws, { type: "error", error: "invalid_json" });
      }

      touch(nodeId);

      switch (msg.type) {
        case "heartbeat": {
          send(ws, { type: "heartbeat_ack", ts: Date.now() });
          break;
        }

        case "peer_request": {
          send(ws, { type: "peers", peers: listPeers() });
          break;
        }

        case "message": {
          // Relay-first: try direct delivery, otherwise persist as an event
          // so the recipient picks it up on next sync/reconnect.
          const target = connections.get(msg.target_node_id);
          const eventRow = appendEvent({
            nodeId,
            eventType: "MESSAGE_CREATED",
            payload: {
              target_node_id: msg.target_node_id,
              ciphertext: msg.ciphertext,
            },
            signature: msg.signature || null,
            clientEventId: msg.client_event_id || null,
          });

          if (target) {
            send(target, {
              type: "message",
              from: nodeId,
              ciphertext: msg.ciphertext,
              global_seq: eventRow.global_seq,
            });
            send(ws, {
              type: "message_delivered",
              target_node_id: msg.target_node_id,
              global_seq: eventRow.global_seq,
            });
          } else {
            send(ws, {
              type: "message_queued",
              target_node_id: msg.target_node_id,
              global_seq: eventRow.global_seq,
            });
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
        broadcast({ type: "presence", node_id: nodeId, status: "offline" });
      }
    });
  });

  return wss;
}

module.exports = { attach, broadcast, isOnline };
