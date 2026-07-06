# Engine Roadmap

Backlog for turning the TagTag MVP into a genuinely reusable engine. Ordered so each slice
ships independently, keeps the app runnable end-to-end, and de-risks the slice after it. Don't
start a slice out of order — later ones assume earlier boundaries exist.

Each slice should end with: app still runs (`bun run dev:server` + `bun run dev:client`), demo
still playable, this file and [`ARCHITECTURE.md`](./ARCHITECTURE.md) updated to reflect new
state.

## Guiding principle: game code stays simple and DX-friendly

The whole point of splitting engine from game logic is that writing a _new game_ should be easy.
If a slice makes the engine more "proper" but a ruleset author now has to write more boilerplate,
understand more engine internals, or fight more ceremony to move a dot on screen, that slice has
failed its purpose — the abstraction leaked the wrong way.

Concretely, while doing plugin-boundary work below (Phases 1–3):

- Prefer a ruleset exposing a handful of plain functions/objects (reducer, render hook, input
  mapper, config) over class hierarchies, decorators, or required boilerplate.
- The engine should have sensible defaults for every piece of ruleset-supplied config — a ruleset
  should be able to override only what it cares about.
- After each slice that touches the plugin boundary (1.2–1.5, 2.2, 3.1–3.6), sanity-check it by
  asking: "if I were writing a second, different game right now, is this pleasant?" If the answer
  is no, that's a signal to simplify before moving to the next slice, not a note for later.
- Keep engine internals (transport, room bookkeeping, prediction math) out of the ruleset author's
  way entirely — a ruleset should never need to know about WebSockets, snapshot diffing, or the
  broadcast loop to be written.

---

## Phase 0 — Define the contract (docs only, no refactor)

### 0.1 Write down the Ruleset interface

No code changes — just decide and document the shape of the plugin boundary before moving files
around, so Phase 1 isn't refactoring twice. Answer on paper:

- What does a ruleset export? (entity shape, `Action` union, `reducer`, per-entity render/visual
  hook, input → action mapper, movement/sync tuning config)
- What does the engine own regardless of ruleset? (transport, connection lifecycle, snapshot
  broadcast, room state, generic client-side prediction/interpolation utility)
- What's the minimal generic `Snapshot<TEntity>` / `Action<TEntity>` shape that isn't tied to
  `{x, y}`?

**Done when:** a short doc (can be a section in this file or a new `ENGINE_API.md`) states the
interface. Nothing else changes yet.

✅ Done — see [`ENGINE_API.md`](./ENGINE_API.md) for the engine/ruleset split, generic core types,
the `Ruleset<TEntity, TAction>` shape, and a worked TagTag example.

---

## Phase 1 — Extract the plugin boundary

Goal: prove the boundary from 0.1 actually works by making the _existing_ demo game (TagTag) the
first plugin, not a special case hardcoded into the engine.

### 1.1 Generalize `packages/state` → engine core types

Make `Snapshot`/`Action`/`reducer` generic over entity/action shape instead of hardcoded to
`{x, y}` + `MOVE`. This package becomes the engine's core contract, not game logic.

### 1.2 Move TagTag-specific rules into `packages/rulesets/tagtag`

Relocate the current `MOVE`-adds-a-vector reducer, entity shape, and movement constants
(`MOVE_SPEED`, etc.) out of engine core and into the first real ruleset package.

✅ 1.1 + 1.2 done together (splitting them left the app non-functional in between):
`packages/state` is now generic (`Snapshot<TEntity>`, `EngineAction<TAction>`, `createReducer`
helper that handles JOIN/LEAVE so a ruleset only implements its own action cases).
`packages/rulesets/tagtag` holds the dot entity shape, `MOVE` reducer, and movement/sync
constants. Server and client now import ruleset-specific types/values from `tagtag` and only
generic `Snapshot`/`EngineAction` from `state`. Verified: typecheck passes, server+client boot,
and a raw WebSocket smoke test confirms JOIN → snapshot → MOVE → updated snapshot still works.

### 1.3 Server loads a ruleset instead of importing one hardcoded reducer

`apps/server` takes a ruleset (reducer + initial entity factory) as configuration rather than
importing `state`'s reducer directly. Still only one ruleset active at a time — no multi-room yet.

### 1.4 Client renders via ruleset-supplied visuals

Replace the hardcoded color/radius logic in `Game.svelte` with a hook the ruleset provides
("how do I draw this entity"). Engine just diffs snapshots and calls the hook.

### 1.5 Client input goes through a ruleset-supplied input mapper

Replace hardcoded WASD→dx/dy in `Game.svelte` with a mapper the ruleset defines (keys → Action).
Engine owns raw key capture and the send-tick loop; ruleset owns what a key means.

**Done when:** the app behaves identically to today, but `Game.svelte` and the server no longer
contain any TagTag-specific logic — swapping `tagtag` for a stub second ruleset requires no
engine changes. Also apply the DX check above: the `tagtag` package itself should read as a
short, plain description of the game's rules — no engine ceremony required to understand it.

✅ 1.3 was effectively covered by 1.1/1.2 (server already takes the ruleset's reducer as
configuration). 1.4 + 1.5 done: `state` now also exports generic `InputState` (which directional
keys are held) and `EntityAppearance` (color/radius) types. `tagtag` exports `renderEntity`
(entity + isLocal → appearance), `mapInput` (raw input + entityId → `Action | null`, used at the
network tick), and `predictStep` (raw input + dt → local per-frame displacement, used by the
60fps ticker). `Game.svelte` no longer contains WASD-to-direction logic, movement math, or
color/radius — it only captures keys into `InputState` and calls these three hooks. Verified:
typecheck clean, two simulated WebSocket clients moving/joining/leaving behave identically to
before (including server rejecting a client's attempt to move another entity).

---

## Phase 2 — Generic client sync module

Goal: the prediction/reconciliation/interpolation logic (currently inline in `Game.svelte`)
becomes a reusable engine utility instead of hand-rolled once.

### 2.1 Extract `pursue()` + prediction/reconciliation into an engine package

New module (e.g. `packages/engine-client` or a `sync` export from the engine) providing:
local prediction, snap/freeze reconciliation against authoritative state, and remote-entity
pursuit/interpolation — parameterized by speed/thresholds/tick rate, not hardcoded.

### 2.2 Ruleset supplies the tuning values

`MOVE_SPEED`, `STOP_SNAP_DISTANCE`, `STOP_FREEZE_DISTANCE`, `REMOTE_PURSUIT_SPEED`,
`INPUT_INTERVAL_MS` move to ruleset-level config, passed into the engine sync module. Confirms
the Phase 0 decision about where these constants belong.

**Done when:** `Game.svelte` has no movement-tuning constants left — it wires the engine sync
module together with a ruleset's config and rendering hooks. A ruleset should be able to omit
this config entirely and get reasonable default movement feel, only overriding values it
actually cares about.

✅ Done: new `packages/engine-client` owns `SyncConfig`/`defaultSyncConfig`/`resolveSyncConfig`,
per-entity `EntitySyncState` bookkeeping, and the three sync operations (`applyLocalStep` —
predict/snap/freeze — `applyRemoteStep` — pursuit interpolation — and the internal `pursue`
chase). `tagtag` exports `sync: Partial<SyncConfig>` built from its internal tuning constants
(no longer publicly exported individually). `Game.svelte` now has zero movement-tuning constants
or reconciliation math — it calls `resolveSyncConfig(sync)` once and delegates every frame to
`applyLocalStep`/`applyRemoteStep`. A ruleset that supplies no `sync` at all gets
`defaultSyncConfig`, satisfying the "omit and still feel reasonable" requirement. Verified:
typecheck clean, server+client boot, and the two-client WebSocket smoke test (join, move, reject
foreign MOVE, leave) still passes unchanged.

---

## Phase 3 — Full engine/game agnosticism, minimal game code

**Priority: do this next, before rooms/robustness/product work.** A review of Phase 1–2 against
the actual code found two gaps that mean the engine isn't yet fully agnostic of game logic, and
game code isn't as minimal as it could be. See `ENGINE_API.md` (v2 contract) for the full design;
summary here.

Gap 1: `apps/server/src/index.ts` and `Game.svelte` both hardcode `import ... from "tagtag"`
directly in engine-owned files — logic is decoupled, wiring isn't. Gap 2: engine core types
(`InputState`'s up/down/left/right, `EntityAppearance`'s color/radius) bake in genre assumptions
(directional movement, circular sprites) that a differently-shaped game would need engine changes
to work around.

### 3.1 Bundle ruleset exports into one `Ruleset` object

Reverses the Phase 1 deviation of using separate named exports. Needed so `startServer`/`runGame`
(3.2/3.3) can take "a ruleset" as a single parameter. `tagtag` exports one `Ruleset<Entity,
Action>` object instead of five named exports.

✅ Done: `packages/state` now exports a `Ruleset<TEntity, TAction>` type (`createEntity`,
`reducer`, `renderEntity`, `mapInput`, `predictStep`, `sync` — still today's v1 field shapes;
3.4/3.5 will evolve `renderEntity`/`mapInput`/`predictStep`'s signatures without touching this
bundling). `state` now depends on `engine-client` (for the `sync` field's `SyncConfig` type) —
the first cross-package dependency between the two, still with no cycle since `engine-client`
depends on nothing. `tagtag` exports a single `tagtag: Ruleset<Entity, Action>` object; its five
functions are no longer individually exported (only `Entity`/`Action` types still are, needed by
`apps/server` until 3.2 makes the server generic over the ruleset's types). `apps/server` and
`Game.svelte` updated to call `tagtag.reducer`/`tagtag.mapInput`/`tagtag.predictStep`/
`tagtag.renderEntity`/`tagtag.sync` instead of five separate imports. Verified: typecheck clean,
server+client boot, and the two-client WebSocket smoke test (join, move, reject foreign MOVE,
leave) still passes unchanged.

### 3.2 Add `packages/engine-server`

New package: `startServer(ruleset, options?)` owns `Bun.serve`, Hono, WebSocket, room state, and
the broadcast loop — everything currently in `apps/server/src/index.ts` except "which ruleset."
`options` covers `port`/`hostname` (currently hardcoded to `3000`/`"0.0.0.0"` — see
`ENGINE_API.md` → "`startServer` options" for the exact shape and defaults, which must match
today's values so behavior doesn't change). `apps/server` shrinks to a 3-line composition root
that imports `engine-server` + a concrete ruleset and calls `startServer(ruleset)`.

✅ Done: new `packages/engine-server` owns `Bun.serve`, Hono, WebSocket upgrade, room state
(single global snapshot), and the broadcast loop, exactly as `apps/server/src/index.ts` did
before. `startServer<TEntity, TAction>(ruleset, options?)` takes only the `reducer` field off the
ruleset (the only piece the server ever touches — `createEntity` is already wrapped into it via
`createReducer`); `options` is `{ port?: number; hostname?: string }`, defaulting to `3000`/
`"0.0.0.0"` to match prior behavior exactly. The server no longer special-cases `"MOVE"` — it
generically rejects any client-sent `JOIN`/`LEAVE` (those are engine-issued only) and any action
targeting an entity the sender doesn't own, so a differently-shaped ruleset's actions aren't
rejected by an engine-owned type check. `apps/server/src/index.ts` is now 3 lines: import
`startServer` from `engine-server`, import `tagtag`, call `startServer(tagtag)`. Its
`package.json` now depends only on `engine-server` + `tagtag` (no more direct `hono`/`state`
deps). Verified: typecheck clean, server+client boot, and the two-client WebSocket smoke test
(join, move, reject foreign MOVE, leave) still passes unchanged.

### 3.3 Add `packages/engine-client-pixi`

New package: `runGame(container, ruleset) -> dispose()` owns the Pixi `Application`, WebSocket
client, ticker loop, and raw key capture — everything currently in `Game.svelte` except "which
ruleset." `Game.svelte` shrinks to mounting `runGame(container, ruleset)` in `onMount`.

✅ Done: new `packages/engine-client-pixi` owns the Pixi `Application` lifecycle, WebSocket
connection, per-entity `Graphics` bookkeeping, the ticker loop (predict/reconcile/pursue via
`engine-client`), and WASD key capture — exactly what `Game.svelte` did before, moved verbatim
into `runGame<TEntity, TAction>(container, ruleset) -> dispose()`. `TEntity` is constrained to
`{x, y}` (matching `engine-client`'s position-based sync, unchanged in this slice) and `TAction`
to `{type, entityId}` (matching the wire protocol). `Game.svelte` is now 12 lines: mounts
`runGame(container, tagtag)` in `onMount` and returns its `dispose` as the cleanup function.
`apps/client/package.json` now depends only on `engine-client-pixi` + `tagtag` (no more direct
`engine-client`/`state`/`pixi.js` deps). Verified: typecheck clean, server+client boot, a browser
screenshot shows the local dot rendering correctly, and the two-client WebSocket smoke test
(join, move, reject foreign MOVE, leave) still passes unchanged.

### 3.4 Replace `InputState` with `RawInput`

`RawInput` is purely mechanical (which physical keys are held, no semantic meaning) and lives in
`packages/state`. All directional interpretation, including which physical keys mean "up" etc.,
moves entirely into the ruleset's `mapInput`/`predictStep` — the engine no longer assumes
directional movement is a thing every game has.

✅ Done: `packages/state` now exports `RawInput` (`{ keysDown: ReadonlySet<string> }`) instead of
`InputState`; `Ruleset.mapInput`/`Ruleset.predictStep` both take `RawInput`. `engine-client-pixi`
no longer maps physical keys to directions at all — it just tracks a raw `Set<string>` of held
keys (normalized via `.toLowerCase()`) on `keydown`/`keyup`, and (unlike the old per-key WASD
switch) no longer calls `preventDefault`, since the engine has no way to know which keys a given
ruleset cares about; browser shortcuts on unused keys keep working. `tagtag` now owns its own
`KEY_UP`/`KEY_DOWN`/`KEY_LEFT`/`KEY_RIGHT` ("w"/"s"/"a"/"d") constants and reads them off
`input.keysDown` inside `getDirection`, used by both `mapInput` and `predictStep`. Verified:
typecheck clean, server+client boot, a browser test holding "d" moved the local dot right (probe
WebSocket confirmed the server-side entity moved from `x:0` to `x:636`, rendered position tracked
via pursuit), and the two-client WebSocket smoke test (join, move, reject foreign MOVE, leave)
still passes unchanged.

### 3.5 Replace `EntityAppearance` with a `draw` hook

Remove the declarative `{color, radius}` descriptor. The ruleset gets a real Pixi `Graphics`
object (already positioned by the engine) and draws into it directly — a scoped, documented
exception to "ruleset never touches Pixi" (see `ENGINE_API.md` → "Where the Pixi exception
lives"). This is what makes rendering genuinely shape-agnostic instead of assuming every entity
is a colored circle.

✅ Done: `packages/state`'s `Ruleset` type gained a `TGraphics` type parameter (defaults to
`unknown`, so `state` still never imports Pixi) and replaced the `renderEntity`/`EntityAppearance`
field with `draw: (graphics: TGraphics, entity: TEntity, isLocal: boolean) => void`; the
`EntityAppearance` type is removed entirely. `engine-client-pixi` now calls `graphics.clear()`
itself immediately before `ruleset.draw(...)` (so a ruleset's `draw` never needs to clear), and
specializes `Ruleset<TEntity, TAction, Graphics>` with Pixi's real `Graphics` type. `tagtag`
exports `draw(graphics, _entity, isLocal)`, drawing a circle + fill directly onto the given
`Graphics` — its only Pixi import, type-only, matching "Where the Pixi exception lives." Verified:
typecheck clean, server+client boot, and a browser test showed both the local dot (green,
radius 16, drawn via `draw`) and a remote dot (blue, radius 12, moved via a raw WebSocket client)
rendering correctly; the two-client WebSocket smoke test (join, move, reject foreign MOVE, leave)
still passes unchanged.

### 3.6 Rewire `apps/server` and `apps/client` as thin composition roots

After 3.1–3.5 land, update both apps to the minimal form shown in `ENGINE_API.md` — each is just
"import the engine's start function, import a ruleset, call the function." Verify: swapping which
ruleset runs requires changing exactly one import in each app, and zero changes anywhere under
`packages/engine-*`.

**Done when:** neither `packages/state`, `packages/engine-client`, `packages/engine-client-pixi`,
nor `packages/engine-server` import or reference `tagtag` (or any ruleset) anywhere. `tagtag`
remains a single small file with zero Pixi/WebSocket/Bun imports beyond the one documented
`Graphics`-drawing exception in `draw`. `apps/server` and `apps/client` are each just a few lines
wiring one ruleset into the engine.

✅ Done: `apps/server/src/index.ts` (3 lines) and `Game.svelte` (12 lines) already reached this
minimal form as a natural side effect of 3.2/3.3 — this slice was mostly verification. Confirmed
by temporarily adding a second, deliberately different throwaway ruleset (`stub`: arrow-key
movement, square sprites, no `sync` override) and swapping both apps to boot it by changing
exactly one import line each (`tagtag` → `stub`) with zero edits under `packages/engine-*`;
typecheck passed, and a WebSocket-level smoke test confirmed `stub`'s reducer/`MOVE` action
worked identically through the unmodified `engine-server`, and a browser screenshot showed its
orange/yellow squares rendering via the unmodified `engine-client-pixi`. Reverted the swap and
deleted the throwaway `stub` package after verifying (kept out of the repo — it was a disposable
test fixture, not a second real ruleset). `packages/state`/`engine-client`/`engine-client-pixi`/
`engine-server` contain zero references to `tagtag`, confirmed by grep. Verified: typecheck
clean, server+client boot with `tagtag` restored, and the two-client WebSocket smoke test (join,
move, reject foreign MOVE, leave) still passes unchanged. **Phase 3 is complete.**

---

## Phase 4 — Session/room abstraction

Goal: stop assuming "one global room, one snapshot, one ruleset" on the server.

### 4.1 Introduce a `Room` concept server-side

Wrap the existing single-room state (snapshot, sockets, apply/broadcast) in a `Room` type, still
instantiate exactly one at boot. Pure refactor — no behavior change — but now rooms are a unit.

### 4.2 Support multiple concurrent rooms

Server can host N rooms (same or different rulesets), keyed by room ID. Client picks/creates a
room (simplest possible UX — e.g. a URL query param — full matchmaking is out of scope for now).

**Done when:** two independent matches can run on one server process without interfering.

---

## Phase 5 — Robustness essentials

These matter once more than one person is trying the engine, or once games run longer than a demo
session.

### 5.1 Server-side input validation

Reject malformed/out-of-range `Action`s (e.g. absurd `dx`/`dy`) instead of trusting client input
at face value. Baseline anti-cheat, not full validation framework.

### 5.2 Reconnection handling

Client retries the socket on drop; server gives a disconnected entity a grace period before
`LEAVE` instead of removing it instantly.

### 5.3 Automated tests

Unit tests for reducers (engine core + tagtag ruleset) and the wire protocol
(`WELCOME`/`Snapshot`/`Action` (de)serialization). No test infra exists today.

**Done when:** a bad actor or flaky network can't break the room, and a regression in a reducer
fails CI instead of being caught by hand.

---

## Phase 6 — Product features (previously "explicitly out of scope")

Only start once Phases 1–5 are done — these are additive product needs, not engine architecture,
and doing them earlier risks building auth/persistence against an API shape that earlier phases
will still change.

- **6.1 Auth** (BetterAuth) — real player identity instead of ephemeral `entityId`.
- **6.2 Database** (Neon) — persistence for accounts/match history/whatever a given game needs.
- **6.3 Deployment** (Railway) — ship server + client somewhere reachable outside LAN.
- **6.4 Build tooling** (Turborepo) — only if/when the monorepo has enough packages that plain
  Bun workspaces scripts get painful. Revisit at the end, not preemptively.

---

## Explicitly not scheduled yet

Carried over from [`ARCHITECTURE.md`](./ARCHITECTURE.md), still correctly out of scope until a
real second game demands them:

- Grid/tile/isometric spatial models (a second ruleset will tell us what's actually needed)
- Matchmaking/lobby UI beyond "pick a room ID"
- Anything genre-specific (turn order, inventories, physics, etc.)

## How to use this file

Work top to bottom, one numbered slice at a time. After finishing a slice: verify the demo still
runs, update [`ARCHITECTURE.md`](./ARCHITECTURE.md)'s package layout table if it changed, check
off the slice below, and commit before starting the next one.

- [x] 0.1
- [x] 1.1
- [x] 1.2
- [x] 1.3
- [x] 1.4
- [x] 1.5
- [x] 2.1
- [x] 2.2
- [x] 3.1
- [x] 3.2
- [x] 3.3
- [x] 3.4
- [x] 3.5
- [x] 3.6
- [ ] 4.1
- [ ] 4.2
- [ ] 5.1
- [ ] 5.2
- [ ] 5.3
- [ ] 6.1
- [ ] 6.2
- [ ] 6.3
- [ ] 6.4
