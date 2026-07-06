# Game Engine — Project Spec

## What this is

A generic multiplayer game engine. The engine itself is genre-agnostic — it provides shared state management, real-time sync between clients, and rendering infrastructure. Actual game rules/content will eventually plug in as separate packages, not hardcoded into the engine.

The current MVP is a content-free demo called **TagTag**: one dot per connected client, movable in real time, proving the sync loop (shared state, actions, broadcast).

## Current state

**MVP complete** — multiplayer dot sync (TagTag) works locally and over LAN.

| Area                       | Status                                                                       |
| -------------------------- | ---------------------------------------------------------------------------- |
| `packages/state`           | Generic engine core — `Snapshot<T>`, `EngineAction<T>`, `createReducer`      |
| `packages/engine-client`   | Generic client sync — prediction, reconciliation, remote interpolation       |
| `packages/rulesets/tagtag` | TagTag game logic — entity shape, `MOVE` reducer, input/render hooks, tuning |
| `apps/server`              | Bun + Hono + WebSocket; authoritative single-room broadcast, ruleset-driven  |
| `apps/client`              | Vite + Svelte + PixiJS; wires engine sync + ruleset hooks together           |
| Monorepo                   | Bun workspaces, Prettier, root tooling                                       |
| Auth, database, deployment | Not started                                                                  |

Everything described below in "How it works" is accurate to the code as it exists right now
(what `ROADMAP.md` calls the **v1** contract — Phase 1 plugin boundary + Phase 2 sync module, both
done). **A significant redesign is next and not yet started:** `ROADMAP.md` Phase 3 / `ENGINE_API.md`'s
**v2** contract will bundle `tagtag`'s exports into one `Ruleset` object, add two new packages
(`engine-server`, `engine-client-pixi`) so the apps stop hardcoding which ruleset they import, and
replace `InputState`/`EntityAppearance` with more genre-agnostic `RawInput`/`draw` hooks. Read
`ENGINE_API.md` before making further changes — its top banner states which parts of that doc are
implemented vs. planned.

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

Generic engine core — no Bun, Node, DOM, or Pixi imports, and no knowledge of any specific game.

- `Snapshot<TEntity>` — map of entity IDs to a ruleset-defined entity shape
- `EngineAction<TAction>` — `JOIN` / `LEAVE` (engine-issued lifecycle actions) layered with a
  ruleset's own action union
- `createReducer(createEntity, customReducer)` — wraps a ruleset's reducer with default JOIN/LEAVE
  handling, so a ruleset only implements the action cases it cares about
- `InputState` — which directional keys are currently held (engine captures this; a ruleset
  decides what it means)
- `EntityAppearance` — `{ color, radius }`, what a ruleset's `renderEntity` returns

### `packages/engine-client`

Generic client-side sync — no knowledge of any specific game, no rendering/transport code.

- `SyncConfig` / `defaultSyncConfig` / `resolveSyncConfig(overrides)` — tuning knobs (tick rate,
  prediction speed, reconciliation thresholds), with defaults a ruleset can selectively override
- `EntitySyncState` / `createSyncState` / `updateAuthority` — per-entity position bookkeeping
- `applyLocalStep(state, step, dt, config)` — local prediction; snap/freeze/catch-up reconciliation
  against the latest authoritative position when idle
- `applyRemoteStep(state, dt, config)` — smooth pursuit of a remote entity's latest snapshot (no
  extrapolation)

### `packages/rulesets/tagtag`

The first (and so far only) ruleset — a plugin, not special-cased into the engine. See
`ENGINE_API.md` for the full engine/ruleset contract.

- `Entity` — `{ x, y }`
- `Action` — `MOVE` (dx/dy delta)
- `reducer` — built via `state`'s `createReducer`
- `renderEntity(entity, isLocal)` — how to draw a dot (color/radius)
- `mapInput(input, entityId)` — what a held key means; called by the client at the network tick to
  build the outgoing `MOVE` action (or skip if idle)
- `predictStep(input, dt)` — local per-frame displacement, called every rendered frame for smooth
  60fps local movement ahead of the network tick
- `sync: Partial<SyncConfig>` — TagTag's movement/reconciliation tuning, passed to
  `engine-client`'s `resolveSyncConfig`

### `apps/server`

- `Bun.serve` with Hono on `fetch`, WebSocket on `/ws`
- On connect: assign entity ID, send `WELCOME`, apply `JOIN`, broadcast `Snapshot`
- On message: accept `MOVE` for own entity only, apply via reducer, broadcast
- On disconnect: apply `LEAVE`, broadcast
- Single global room — all clients share one snapshot

### `apps/client`

- Pixi canvas — one dot per entity (green = yours, blue = others)
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

Open the client in two tabs (or two machines on LAN). Moving your dot with WASD updates in the other view in real time.

## Explicitly out of scope (for now)

- Game genre, rules, or content beyond TagTag
- Auth (BetterAuth)
- Database (Neon)
- Multiple rooms / matchmaking
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

| Package                    | Role                                                                   |
| -------------------------- | ---------------------------------------------------------------------- |
| `state`                    | Generic engine core — `Snapshot`/`EngineAction` types, `createReducer` |
| `engine-client`            | Generic client sync — prediction, reconciliation, remote interpolation |
| `packages/rulesets/tagtag` | Pluggable TagTag game logic (first ruleset)                            |

Apps: `client`, `server`

See `ENGINE_API.md` for the engine/ruleset contract these packages implement. Note:
`engine-server` and `engine-client-pixi` (which `ENGINE_API.md` describes) don't exist yet — they
are planned for `ROADMAP.md` Phase 3, not currently in the repo.
