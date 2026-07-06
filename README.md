# Game Engine — Project Spec

## What this is

A generic multiplayer game engine. The engine itself is genre-agnostic — it provides shared state management, real-time sync between clients, and rendering infrastructure. Actual game rules/content will eventually plug in as separate packages, not hardcoded into the engine.

The current MVP is a content-free demo called **TagTag**: one dot per connected client, movable in real time, proving the sync loop (shared state, actions, broadcast).

## Current state

**MVP complete** — multiplayer dot sync (TagTag) works locally and over LAN.

| Area                          | Status                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| `packages/state`              | Generic engine core — `Snapshot<T>`, `EngineAction<T>`, `createReducer`, `Ruleset<T,A>` |
| `packages/engine-client`      | Generic client sync — prediction, reconciliation, remote interpolation                  |
| `packages/rulesets/tagtag`    | TagTag game logic, bundled into one `tagtag: Ruleset<Entity, Action>` object            |
| `packages/engine-server`      | Generic server — `startServer(ruleset, options?)`: Bun+Hono+WebSocket, room, broadcast  |
| `packages/engine-client-pixi` | Generic Pixi client — `runGame(container, ruleset) -> dispose()`                        |
| `apps/server`                 | 3-line composition root — `startServer(tagtag)`                                         |
| `apps/client`                 | Composition root — mounts `runGame(container, tagtag)`                                  |
| Monorepo                      | Bun workspaces, Prettier, root tooling                                                  |
| Auth, database, deployment    | Not started                                                                             |

**`ROADMAP.md` Phase 3 is done** — the codebase now fully matches the v2 contract in
`ENGINE_API.md`: bundled `Ruleset` object, `packages/engine-server`, `packages/engine-client-pixi`,
`RawInput`, and the `draw` hook. Neither app hardcodes which ruleset it imports outside its own
composition-root file (verified by swapping in a throwaway second ruleset, changing exactly one
import line per app, with zero edits under `packages/engine-*`), the engine has no
directional-movement or circular-sprite assumptions baked in, and
`packages/state`/`engine-client`/`engine-client-pixi`/`engine-server` never reference `tagtag`.
`ENGINE_API.md`'s top banner is now stale (still says "not yet implemented") — treat this README
and `ROADMAP.md` as the source of truth for what's actually built; `ENGINE_API.md` remains
accurate as the contract description itself.

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
- `RawInput` — `{ keysDown: ReadonlySet<string> }`, purely mechanical: which physical keys are
  held, normalized via `.toLowerCase()`. No semantic meaning — a ruleset's `mapInput`/
  `predictStep` interpret it entirely, including which physical keys mean anything at all
- `Ruleset<TEntity, TAction, TGraphics = unknown>` — bundles a ruleset's `createEntity`/
  `reducer`/`draw`/`mapInput`/`predictStep`/`sync` into one object (see `ENGINE_API.md`); depends
  on `packages/engine-client` for the `sync` field's `SyncConfig` type. `TGraphics` defaults to
  `unknown` so this package never needs a Pixi dependency — `engine-client-pixi` specializes it
  to Pixi's real `Graphics` type for the `draw` field

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

- `Entity` — `{ x, y }`, `Action` — `MOVE` (dx/dy delta) — still individually exported types
- `tagtag: Ruleset<Entity, Action, Graphics>` — the entire game, bundled into one object:
  - `reducer` — built via `state`'s `createReducer`
  - `draw(graphics, entity, isLocal)` — draws a circle onto the given (already-positioned,
    already-cleared) Pixi `Graphics` object; TagTag's only Pixi import, type-only, and the one
    documented spot a ruleset touches Pixi (see `ENGINE_API.md` → "Where the Pixi exception lives")
  - own `KEY_UP`/`KEY_DOWN`/`KEY_LEFT`/`KEY_RIGHT` ("w"/"s"/"a"/"d") key bindings — the engine
    only provides raw held-key state (`RawInput`), TagTag decides what any key means
  - `mapInput(input, entityId)` — reads `input.keysDown` to build the outgoing `MOVE` action (or
    skip if idle); called by the client at the network tick
  - `predictStep(input, dt)` — local per-frame displacement, called every rendered frame for
    smooth 60fps local movement ahead of the network tick
  - `sync: Partial<SyncConfig>` — TagTag's movement/reconciliation tuning, passed to
    `engine-client`'s `resolveSyncConfig`

### `packages/engine-server`

Generic multiplayer server — no knowledge of any specific game.

- `startServer(ruleset, options?)` — `Bun.serve` with Hono on `fetch`, WebSocket on `/ws`
- On connect: assign entity ID, send `WELCOME`, apply `JOIN`, broadcast `Snapshot`
- On message: reject client-sent `JOIN`/`LEAVE` (engine-issued only) and actions targeting an
  entity the sender doesn't own; otherwise apply via the ruleset's `reducer`, broadcast
- On disconnect: apply `LEAVE`, broadcast
- Single global room — all clients share one snapshot
- `options: { port?: number; hostname?: string }` — default `3000` / `"0.0.0.0"` (LAN-accessible)

### `apps/server`

Composition root — `import { startServer } from "engine-server"; import { tagtag } from "tagtag"; startServer(tagtag)`.

### `packages/engine-client-pixi`

Generic Pixi-based game client — no knowledge of any specific game.

- `runGame(container, ruleset) -> dispose()` — owns the Pixi `Application`, WebSocket connection,
  ticker loop, and raw key capture (tracks which keys are held as a `RawInput`, with no
  interpretation — a ruleset's `mapInput`/`predictStep` decide what any key means)
- Pixi canvas — one `Graphics` object per entity; the engine calls `graphics.clear()` then the
  ruleset's `draw(graphics, entity, isLocal)` every time a snapshot arrives
- Input sent at the ruleset's configured rate (**20Hz** for TagTag); local player renders at
  **60fps** (ticker-driven)
- Remote entities smoothed via pursuit toward latest snapshot (no extrapolation)
- Local stop uses freeze/snap to avoid bounce-back from server lag

### `apps/client`

Composition root — `Game.svelte` mounts `runGame(container, tagtag)` in `onMount` and returns its
`dispose` as Svelte's cleanup function. **WASD** movement is TagTag's key binding, interpreted by
`tagtag.mapInput`/`tagtag.predictStep` (not hardcoded in the client app).

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

| Package                    | Role                                                                             |
| -------------------------- | -------------------------------------------------------------------------------- |
| `state`                    | Generic engine core — `Snapshot`/`EngineAction`/`Ruleset` types, `createReducer` |
| `engine-client`            | Generic client sync — prediction, reconciliation, remote interpolation           |
| `engine-server`            | Generic server — `startServer(ruleset, options?)`                                |
| `engine-client-pixi`       | Generic Pixi client — `runGame(container, ruleset) -> dispose()`                 |
| `packages/rulesets/tagtag` | Pluggable TagTag game logic (first ruleset)                                      |

Apps: `client`, `server`

See `ENGINE_API.md` for the engine/ruleset contract these packages implement. `engine-server`
(3.2) and `engine-client-pixi` (3.3) are both done — remaining Phase 3 work (3.4/3.5) replaces
`InputState`/`EntityAppearance` with `RawInput`/`draw`.
