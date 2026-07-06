# Architecture

A package-by-package walkthrough of how the engine is wired together. See
[`ENGINE_API.md`](./ENGINE_API.md) for the formal engine/ruleset contract and
[`ROADMAP.md`](./ROADMAP.md) for what's built vs. planned. The root [`README.md`](../README.md)
is the place to start if you just want to run the demo.

## Package layout

| Package                    | Role                                                                              |
| --------------------------- | --------------------------------------------------------------------------------- |
| `state`                    | Generic engine core — `Snapshot`/`EngineAction`/`Ruleset` types, `createReducer` |
| `engine-client`            | Generic client sync — prediction, reconciliation, remote interpolation           |
| `engine-server`            | Generic server — `startServer(ruleset, options?)`                                |
| `engine-client-pixi`       | Generic Pixi client — `runGame(container, ruleset) -> dispose()`                 |
| `packages/rulesets/tagtag` | Pluggable TagTag game logic (first ruleset)                                      |

Apps: `client`, `server`.

**Guiding rule:** `state`, `engine-client`, `engine-client-pixi`, and `engine-server` never
import or reference `tagtag` (or any ruleset) by name — a ruleset is always a plain object passed
in as a parameter (`startServer(ruleset)` / `runGame(container, ruleset)`). Swapping which game
runs means changing one import line in `apps/server` and `apps/client`, nothing under
`packages/engine-*`.

## `packages/state`

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
  - Optional `worldSize?: { width, height }` — when set, `engine-client-pixi` centers a fixed-size
    world in the viewport instead of drawing directly onto the raw stage
  - Optional `title?: string` — when set (with `worldSize`), `engine-client-pixi` renders it above
    the world
  - Optional `sound?: (next, prev, isLocal) => string | null` — given an entity's previous and
    current state (every entity, every snapshot, not just the local one), return a sound asset
    URL to play or `null`; a ruleset detects "what happened" by diffing prev/next itself, the
    engine just loads and plays whatever URL comes back

## `packages/engine-client`

Generic client-side sync — no knowledge of any specific game, no rendering/transport code.

- `SyncConfig` / `defaultSyncConfig` / `resolveSyncConfig(overrides)` — tuning knobs (tick rate,
  prediction speed, reconciliation thresholds), with defaults a ruleset can selectively override
- `EntitySyncState` / `createSyncState` / `updateAuthority` — per-entity position bookkeeping
- `applyLocalStep(state, step, dt, config)` — local prediction; snap/freeze/catch-up reconciliation
  against the latest authoritative position when idle
- `applyRemoteStep(state, dt, config)` — smooth pursuit of a remote entity's latest snapshot (no
  extrapolation)

## `packages/rulesets/tagtag`

The first (and so far only) ruleset — a plugin, not special-cased into the engine. See
`ENGINE_API.md` for the full engine/ruleset contract.

- `Entity` — `{ x, y, isTagger, tagCooldownUntil, color }`, `Action` — `MOVE` (dx/dy delta) — still
  individually exported types
- The game: each client controls one dot in a fixed **960×540** arena; one dot is "it" (the
  tagger, drawn red) and chases the rest. With 2+ players and no tagger, one is picked at random
  — the game starts on the second join and reverts to "no tagger" (free movement) if the room
  drops back to 1 player. Tag-on-overlap is symmetric: whichever entity's `MOVE` lands within
  `COLLISION_DISTANCE` of the tagger triggers the transfer, whether it's the tagger closing in on
  a runner or a runner bumping into a stationary tagger. A tag hands off `isTagger` and starts a
  shared, room-wide **3s cooldown** (`tagCooldownUntil`, server `Date.now()`) during which no
  further tags happen; the tagger flashes red/identity-color while on cooldown. Each player gets
  a unique identity color from a small hue-spaced palette (assigned on join, chosen to maximize
  distance from colors already in use; reused once the palette is exhausted). Players spawn at a
  random arena position, not the center.
- `tagtag: Ruleset<Entity, Action, Graphics>` — the entire game, bundled into one object:
  - `reducer` — built on `state`'s `createReducer`; clamps each `MOVE` to the arena (entity
    centers kept inside so radius-16 dots stay fully visible), then resolves tag transfers,
    assigns/clears the tagger on join/leave, and assigns each joiner's color
  - `draw(graphics, entity, isLocal)` — draws a circle onto the given (already-positioned,
    already-cleared) Pixi `Graphics` object, colored by tagger/identity/flash state, with a simple
    face (two eyes + a mouth curve, mirrored to smile or frown based on `isTagger`) on top; the
    local player also strokes the arena border (anchored in world space via the graphics node's
    own offset, so it renders correctly regardless of that player's position); TagTag's only Pixi
    import, type-only, and the one documented spot a ruleset touches Pixi (see `ENGINE_API.md` →
    "Where the Pixi exception lives")
  - own `KEY_UP`/`KEY_DOWN`/`KEY_LEFT`/`KEY_RIGHT` ("w"/"s"/"a"/"d") key bindings — the engine
    only provides raw held-key state (`RawInput`), TagTag decides what any key means
  - `mapInput(input, entityId)` — reads `input.keysDown` to build the outgoing `MOVE` action (or
    skip if idle); called by the client at the network tick
  - `predictStep(input, dt)` — local per-frame displacement (same arena clamp as the reducer),
    called every rendered frame for smooth 60fps local movement ahead of the network tick
  - `sync: Partial<SyncConfig>` — TagTag's movement/reconciliation tuning, passed to
    `engine-client`'s `resolveSyncConfig`
  - `worldSize`/`title` — the 960×540 arena and the "Tag-Tag" heading shown above it
  - `sound(next, prev)` — plays `assets/gotcha.wav` on an actual catch, detected via
    `tagCooldownUntil` increasing (only a real tag transfer bumps it — an administrative tagger
    assignment/reassignment, e.g. the second join or re-picking a tagger after a disconnect
    briefly drops the room to 1 player, does not); the `.wav` lives in
    `packages/rulesets/tagtag/assets` and is imported like any other TagTag-owned asset — the
    engine never references it by name

## `packages/engine-server`

Generic multiplayer server — no knowledge of any specific game.

- `startServer(ruleset, options?)` — `Bun.serve` with Hono on `fetch`, WebSocket on `/ws`
- On connect: assign entity ID, send `WELCOME`, apply `JOIN`, broadcast `Snapshot`
- On message: reject client-sent `JOIN`/`LEAVE` (engine-issued only) and actions targeting an
  entity the sender doesn't own; otherwise apply via the ruleset's `reducer`, broadcast
- On disconnect: apply `LEAVE`, broadcast
- Single global room — all clients share one snapshot
- `options: { port?: number; hostname?: string; staticDir?: string }` — `port` defaults to
  `process.env.PORT` (falling back to `3000`), `hostname` to `"0.0.0.0"` (LAN-accessible); when
  `staticDir` is set, it's served for any non-`/ws` request (SPA fallback to its `index.html`) —
  this is what lets one deployed service serve both the client and the API (see
  [`DEPLOYMENT.md`](./DEPLOYMENT.md))

## `packages/engine-client-pixi`

Generic Pixi-based game client — no knowledge of any specific game.

- `runGame(container, ruleset) -> dispose()` — owns the Pixi `Application`, WebSocket connection,
  ticker loop, and raw key capture (tracks which keys are held as a `RawInput`, with no
  interpretation — a ruleset's `mapInput`/`predictStep` decide what any key means)
- Pixi canvas — one `Graphics` object per entity, parented under a `Container` ("world") that's
  centered in the viewport (and re-centered on resize) when the ruleset sets `worldSize`;
  otherwise the world sits at the stage origin, unchanged from before. An optional `title` is
  rendered as Pixi `Text` above the world.
- The engine calls `graphics.clear()` then the ruleset's `draw(graphics, entity, isLocal)` both
  whenever a snapshot arrives and on every rendered ticker frame (using the client's latest
  predicted/reconciled position merged onto the last-known entity fields) — so time-based visuals
  (e.g. TagTag's cooldown flash) and world-anchored drawing stay smooth between snapshots, not
  just updating once per server broadcast
- When a snapshot arrives, the engine also calls the optional `ruleset.sound(next, prev, isLocal)`
  for every entity (prev is `undefined` for a brand-new join) and plays whatever URL it returns
  via a plain `Audio` element — the engine owns audio playback, a ruleset owns which asset plays
  and when
- Input sent at the ruleset's configured rate (**20Hz** for TagTag); local player renders at
  **60fps** (ticker-driven)
- Remote entities smoothed via pursuit toward latest snapshot (no extrapolation)
- Local stop uses freeze/snap to avoid bounce-back from server lag

## `apps/server` and `apps/client`

Both are thin composition roots — the only files allowed to import a concrete ruleset:

- `apps/server/src/index.ts` — `import { startServer } from "engine-server"; import { tagtag } from "tagtag"; startServer(tagtag)`
- `apps/client/src/lib/Game.svelte` — mounts `runGame(container, tagtag)` in `onMount` and returns
  its `dispose` as Svelte's cleanup function. **WASD** movement is TagTag's key binding,
  interpreted by `tagtag.mapInput`/`tagtag.predictStep` (not hardcoded in the client app).

## Wire protocol

| Direction                    | Payload                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------- |
| Client → server              | `Action` JSON (e.g. `{ "type": "MOVE", "entityId": "...", "dx": 12, "dy": 0 }`) |
| Server → client (on connect) | `{ "type": "WELCOME", "entityId": "..." }`                                      |
| Server → client (ongoing)    | Full `Snapshot` JSON (no `type` field)                                          |

WebSocket: `ws://<host>:3000/ws` in dev, `wss://<host>/ws` (same origin as the page) in production
— see [`DEPLOYMENT.md`](./DEPLOYMENT.md)

## Explicitly out of scope (for now)

- Game genre, rules, or content beyond TagTag
- Auth (BetterAuth)
- Database (Neon)
- Multiple rooms / matchmaking
- Grid / tile / isometric spatial models
- Reconnection, error recovery, input validation
- Turborepo

See [`ROADMAP.md`](./ROADMAP.md) for how these are sequenced.
