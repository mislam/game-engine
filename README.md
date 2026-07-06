# Game Engine — Project Spec

## What this is

A generic multiplayer game engine. The engine itself is genre-agnostic — it provides shared state management, real-time sync between clients, and rendering infrastructure. Actual game rules/content will eventually plug in as separate packages, not hardcoded into the engine.

The current MVP is a content-free demo: one circle per connected client, movable in real time, proving the sync loop (shared state, actions, broadcast).

## Current state

**MVP complete** — multiplayer circle sync works locally and over LAN.

| Area                       | Status                                                             |
| -------------------------- | ------------------------------------------------------------------ |
| `packages/state`           | `Snapshot`, `Action`, pure `reducer` — shared by client and server |
| `apps/server`              | Bun + Hono + WebSocket; authoritative single-room broadcast        |
| `apps/client`              | Vite + Svelte + PixiJS; WASD movement, smoothed rendering          |
| Monorepo                   | Bun workspaces, Prettier, root tooling                             |
| Auth, database, deployment | Not started                                                        |

## Prerequisites

- [Bun](https://bun.sh) — package manager, script runner, and server runtime
- Install once from the repo root: `bun install`

## Dev commands

From the repo root:

```sh
bun run dev:server   # http://localhost:3000
bun run dev:client   # http://localhost:5173
bun run format       # Prettier
```

Or from each app directory: `bun run dev`.

### LAN testing

Server and client bind to all interfaces. On other devices (same network), open:

```
http://<host-machine-ip>:5173
```

The client derives the WebSocket URL from the page hostname (`ws://<host>:3000/ws`), so no manual URL changes are needed.

## How it works

### `packages/state`

Environment-agnostic types and reducer — no Bun, Node, DOM, or Pixi imports.

- `Snapshot` — map of entity IDs to `{ x, y }`
- `Action` — `JOIN` / `MOVE` / `LEAVE` (`JOIN` and `LEAVE` are server-initiated)
- `reducer(snapshot, action) -> snapshot`

### `apps/server`

- `Bun.serve` with Hono on `fetch`, WebSocket on `/ws`
- On connect: assign entity ID, send `WELCOME`, apply `JOIN`, broadcast `Snapshot`
- On message: accept `MOVE` for own entity only, apply via reducer, broadcast
- On disconnect: apply `LEAVE`, broadcast
- Single global room — all clients share one snapshot

### `apps/client`

- Pixi canvas — one circle per entity (green = yours, blue = others)
- **WASD** movement
- Input sent at **20Hz**; local player renders at **60fps**
- Remote entities smoothed via pursuit toward latest snapshot (no extrapolation)
- Local stop uses freeze/snap to avoid bounce-back from server lag

### Wire protocol

| Direction                    | Payload                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------- |
| Client → server              | `Action` JSON (e.g. `{ "type": "MOVE", "entityId": "...", "dx": 12, "dy": 0 }`) |
| Server → client (on connect) | `{ "type": "WELCOME", "entityId": "..." }`                                      |
| Server → client (ongoing)    | Full `Snapshot` JSON (no `type` field)                                          |

WebSocket: `ws://<host>:3000/ws`

## Definition of done (achieved)

Open the client in two tabs (or two machines on LAN). Moving your circle with WASD updates in the other view in real time.

## Explicitly out of scope (for now)

- Game genre, rules, or content
- Auth (BetterAuth)
- Database (Neon)
- Multiple rooms / matchmaking
- Pluggable ruleset packages
- Grid / tile / isometric spatial models
- Reconnection, error recovery, input validation
- Deployment (Railway)
- Turborepo

## Tech

- Bun workspaces — install, scripts, server runtime
- Server: Bun + Hono + native WebSocket
- Client: Vite + Svelte (not SvelteKit) + PixiJS
- TypeScript, strict mode

## Package layout

| Package                    | Role                                             |
| -------------------------- | ------------------------------------------------ |
| `state`                    | Shared `Snapshot` / `Action` types, pure reducer |
| `packages/rulesets/<name>` | Pluggable game logic (later)                     |

Apps: `client`, `server`
