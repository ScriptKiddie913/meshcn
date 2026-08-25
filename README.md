# sdmesh-server

Headless Render backend for the Secure De-centralized Mesh. This repo contains
**server-side code only** — no client, no `setup.sh`/`run.sh`, no private
keys. Deploy this to Render as its own service.

It implements:

- Mesh API (Express) — registration, peer discovery, event sync, encrypted backup storage
- WebSocket relay (`/ws`) — real-time message/event push, presence, heartbeats
- Event-sourced persistent database (SQLite via `better-sqlite3`) — `USER_REGISTERED`,
  `KEY_REGISTERED`, `MESSAGE_CREATED`, etc., ordered by a server-side `global_seq`
- `/health` for Render's health checks
- No dashboard/UI — `GET /` returns 404 by design

Client private keys are never sent to or stored by this server. Only public
keys, node IDs, usernames, event records, message metadata, and opaque
encrypted backup blobs live here.

## Deploy to Render

**Option A — Blueprint (recommended)**
1. Push this repo to Git (GitHub/GitLab).
2. In Render: New → Blueprint → point at the repo. `render.yaml` provisions
   the web service, a 1GB persistent disk for the SQLite file, and generates
   `SERVER_SECRET` for you.
3. Deploy. Render will build with `npm install` and start with `npm start`.

**Option B — Manual web service**
1. New → Web Service → connect the repo.
2. Build command: `npm install`
3. Start command: `npm start`
4. Health check path: `/health`
5. Add a persistent disk (e.g. mount at `/opt/render/project/src/data`) and
   set `DATABASE_URL` to a path inside it, e.g.
   `/opt/render/project/src/data/sdmesh.db`. Without a disk, SQLite data is
   lost on every deploy/restart.
6. Set environment variables from `.env.example` — at minimum a strong
   `SERVER_SECRET` (`openssl rand -hex 32`).

## Environment variables

| Var | Required | Description |
|---|---|---|
| `SERVER_SECRET` | yes | HMAC secret used to issue/verify node auth tokens |
| `DATABASE_URL` | yes (prod) | Path to the SQLite file, ideally on a mounted disk |
| `PORT` | no | Render sets this automatically |
| `NODE_ENV` | no | `production` on Render |

## API

### `GET /health`
No auth. `{ status: "ok", service: "sdmesh", global_seq }`.

### `POST /register`
Bootstrap authority for new clients. No auth (this *is* how a client gets
credentials).

```
POST /register
{ "username": "sumo", "node_id": "<client-generated id>", "public_key": "<base64/hex>" }

201 {
  "node_id", "token",              // token = Bearer credential for this node
  "peers": [{node_id, username, public_key, last_seen}, ...],
  "global_seq", "last_event_global_seq"
}
```
Also fires `USER_REGISTERED` and `KEY_REGISTERED` events, and broadcasts a
`peer_update` to any already-connected clients over `/ws`.

### `GET /peers`
Auth required (`x-node-id` + `Authorization: Bearer <token>`). Returns the
full peer/public-key registry.

### `POST /sync`
Auth required. Two-way event sync — how a client (or the whole mesh) recovers
after Render or the client itself was offline.

```
POST /sync
{ "since_global_seq": 110, "new_events": [{event_type, payload, signature?, client_event_id?, timestamp?}] }

200 {
  "accepted": [client_event_id, ...],   // de-duped inserts
  "missing_events": [...],              // events after since_global_seq
  "global_seq": 118
}
```

### `PUT /backup` / `GET /backup`
Auth required. Stores/retrieves one opaque, client-encrypted backup blob per
node. The server cannot read the contents.

### `WS /ws?node_id=...&token=...`
Auth via query params (token from `/register`). One active connection per
node — a new connection replaces the old one.

Client → server message types: `heartbeat`, `peer_request`, `message`
(`{type:"message", target_node_id, ciphertext, client_event_id?, signature?}`).

Server → client message types: `connected`, `peers`, `presence`,
`peer_update`, `message`, `message_delivered`, `message_queued`,
`sync_events`, `heartbeat_ack`, `error`.

Delivery model: if the target node has an open WebSocket, the message is
relayed immediately; otherwise it's persisted as a `MESSAGE_CREATED` event
and the recipient picks it up via `/sync` (`missing_events`) on reconnect.

## Local run

```
cp .env.example .env   # set a real SERVER_SECRET
npm install
npm run dev
```

## Troubleshooting

**Build fails compiling `better-sqlite3` with errors like `PropertyCallbackInfo has no member named 'This'` or deprecated `v8::External::Value()`.**
This happens when Render builds against a very new Node version (e.g. 26.x)
whose V8 headers changed APIs that this native module's compiled version
relies on — it's a Node/V8 mismatch, not an app bug. This repo pins Node to
`20.18.1` via `.node-version`, `package.json#engines`, and `NODE_VERSION` in
`render.yaml`. If Render is still picking a different Node version, check the
service's Environment tab and confirm no `NODE_VERSION` override or newer
default is taking precedence. If you'd rather track newer Node, instead
upgrade `better-sqlite3` to a release that's confirmed to compile against
that Node/V8 combination.

## Notes / intentional simplifications

- Auth tokens are HMAC(node_id) bearer tokens issued at registration, not a
  full challenge/response signature scheme against the client's public key.
  If you want stronger auth, add a signature-verification step (sign a
  server-issued nonce with the client's private key, verify with the stored
  public key) before issuing the token.
- Sync uses a single global `global_seq` watermark rather than full
  per-node vector reconciliation. This is simpler than the per-node
  `last_event`/`last_sequence` reconciliation described in the architecture
  doc but achieves the same practical result: a reconnecting client (or a
  recovering Render instance re-seeded from clients) converges by exchanging
  events relative to a sequence number.
