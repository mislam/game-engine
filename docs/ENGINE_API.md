# Engine ↔ Ruleset Contract

> **Status: IMPLEMENTED.** `ROADMAP.md` Phase 3 ("Full engine/game agnosticism") is done — the
> code as it exists today matches everything below (the **v2** design). `RawInput`, the `draw`
> hook, the bundled `Ruleset<TEntity, TAction, TGraphics>` object, `packages/engine-server`, and
> `packages/engine-client-pixi` all exist and are wired up exactly as described. See
> [`ARCHITECTURE.md`](./ARCHITECTURE.md) for a code-accurate walkthrough of the current packages.
> The **v1** design (separate named exports, `InputState`, `EntityAppearance`) is no longer in
> the repo — see **History** at the bottom for what changed and why.

This is the plugin boundary referenced by `ROADMAP.md`. This document describes the v2
contract, which fixes two gaps found by reviewing the v1 contract (Phase 1–2) against real code:

1. **The apps hardcoded which ruleset to run.** `apps/server/src/index.ts` and `Game.svelte`
   both had `import { ... } from "tagtag"` directly inside engine-owned files. Logic was decoupled
   (no TagTag-specific math outside `tagtag`), but wiring wasn't — swapping games meant editing
   engine files, not just picking a different package.
2. **Engine core types encoded a genre.** `InputState` (`up`/`down`/`left`/`right`) assumed
   directional movement, and physical key bindings (`w`→up, etc.) were hardcoded in `Game.svelte`.
   `EntityAppearance` (`{color, radius}`) assumed circular sprites. A ruleset for a different kind
   of game would need engine core changes, not just a new package.

The v1 design (bundling exports, `mapInput`/`predictStep` shape, `SyncConfig`) is still correct —
see **History** at the bottom for what changed and why. Everything above that section is the
current target.

## Split at a glance (v2)

| Owned by the **engine**                                                                                                                              | Owned by the **ruleset**                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| WebSocket transport, wire protocol, single-room snapshot/connection bookkeeping (`packages/engine-server`; multi-room is Phase 4, not required here) | Entity data shape, custom `Action` types, `reducer` logic                               |
| Connection lifecycle (JOIN/LEAVE), snapshot broadcast loop                                                                                           | Initial entity state (`createEntity`)                                                   |
| Pixi `Application` lifecycle, WebSocket client, ticker loop, raw input capture (`packages/engine-client-pixi`)                                       | How to draw an entity, given a blank `Graphics` object to draw into (`draw`)            |
| Generic prediction/reconciliation/interpolation math (`packages/engine-client`)                                                                      | What a raw input event means (`mapInput`, `predictStep`) and sync tuning (`sync`)       |
| **Nothing** knows which ruleset is active — it's a parameter, not an import                                                                          | Bundled into one `Ruleset` object, passed into the engine by the app (composition root) |

The key change from v1: **the engine packages never import a ruleset by name.** A ruleset is a
plain object passed as an argument to `startServer(ruleset)` / `runGame(container, ruleset)`. Only
the thin app entry points (`apps/server/src/index.ts`, `apps/client/src/lib/Game.svelte`) — which
exist to pick a game and boot it, not to _be_ the engine — import a concrete ruleset package.

## The `Ruleset` object

Bundled (not separate named exports — see History #1 for why this changed):

```ts
type Ruleset<TEntity, TAction> = {
	createEntity: (entityId: string) => TEntity
	reducer: Reducer<TEntity, TAction>

	// Given a Graphics object (already positioned by the engine), draw this entity.
	// Called once per entity every time a snapshot arrives (i.e. at server broadcast cadence,
	// currently on every action from any player — there's no per-entity diffing today), not
	// every rendered frame. Must be idempotent: safe to call repeatedly with the same entity.
	draw: (graphics: Graphics, entity: TEntity, isLocal: boolean) => void

	// Interpret raw input into a wire action (called at the network tick rate), or null if idle.
	mapInput: (input: RawInput, entityId: string) => TAction | null

	// Interpret raw input into a local per-frame displacement (called every rendered frame).
	predictStep: (input: RawInput, dt: number) => Delta

	// Optional — when set, the Pixi client centers this world rectangle in the viewport, and
	// (if `title` is also set) shows a heading above it.
	worldSize?: { width: number; height: number }
	title?: string

	// Optional — given an entity's previous state (undefined if it just joined) and current
	// state, return a sound asset URL to play, or null. Called for every entity every time a
	// snapshot arrives (not just the local one, and not every rendered frame), so a ruleset
	// detects "what happened" by diffing prev/next itself — the engine has no notion of what any
	// transition means, it only knows how to load and play a URL.
	sound?: (next: TEntity, prev: TEntity | undefined, isLocal: boolean) => string | null

	// Optional — engine has defaults for every field.
	sync?: Partial<SyncConfig>
}
```

`Graphics` is PixiJS's drawing primitive type — see "Where the Pixi exception lives" below for why
a ruleset is allowed to touch this one type despite never touching Pixi's `Application`,
transport, or anything else engine-owned. **The engine calls `graphics.clear()` immediately
before invoking `draw`** (matching today's `Game.svelte` behavior), so a ruleset's `draw` never
needs to clear first — it just draws fresh shapes onto an already-blank `Graphics` each call.

## Generic core types

Unchanged from v1 (still in `packages/state`):

```ts
type Snapshot<TEntity> = { entities: Record<string, TEntity> }
type LifecycleAction = { type: "JOIN"; entityId: string } | { type: "LEAVE"; entityId: string }
type EngineAction<TAction> = LifecycleAction | TAction
type Reducer<TEntity, TAction> = (
	snapshot: Snapshot<TEntity>,
	action: EngineAction<TAction>,
) => Snapshot<TEntity>
```

New in v2 — replaces `InputState`:

```ts
// Purely mechanical: which physical keys are currently held. No semantic meaning
// (no "up"/"down") — that interpretation is entirely the ruleset's job now.
type RawInput = {
	keysDown: ReadonlySet<string> // normalized via KeyboardEvent.key.toLowerCase(), e.g. "w", "a", "arrowup"
}
```

The engine owns exactly one mutable `RawInput` object per game session (updated on every
`keydown`/`keyup`) and passes the _same reference_ into `mapInput`/`predictStep` on every call —
it does not allocate a fresh object each tick/frame. `ReadonlySet` is a type-level signal ("don't
mutate this from a ruleset"), not a guarantee of a new object each call.

`EntityAppearance` is removed entirely — replaced by the `draw` hook above, which gets a real
`Graphics` object instead of returning a declarative `{color, radius}` descriptor. This is what
makes rendering genuinely shape-agnostic: the engine doesn't need a vocabulary for "what a game
entity looks like" at all, it just hands over something to draw into.

`SyncConfig`/`resolveSyncConfig`/`EntitySyncState`/`applyLocalStep`/`applyRemoteStep`/`Delta` are
unchanged, still in `packages/engine-client` (already implemented — see that package's source for
the exact shapes; `Ruleset.predictStep`'s return type and `Ruleset.sync`'s type both come from
there). The wire protocol itself (`WELCOME`, full-`Snapshot`-JSON broadcast, `ws://<host>:3000/ws`)
is unchanged from v1 — see [`ARCHITECTURE.md`](./ARCHITECTURE.md)'s "Wire protocol" section for
the exact message shapes.

## Where the Pixi exception lives

The engine still owns 100% of Pixi's `Application` (creation, resize, ticker, canvas mounting) —
a ruleset never touches that. The **only** Pixi surface a ruleset sees is the `Graphics` object
passed into `draw`, which is a drawing-primitive API (`circle`, `rect`, `fill`, etc.), not engine
machinery. This mirrors how essentially every game engine works — games always call their
renderer's drawing primitives directly; what stays engine-owned is lifecycle, transport, and
scene management, not "how do I draw a circle."

If a ruleset needs to load a texture/sprite instead of vector-drawing, `draw` can still do that —
`Graphics`/`Sprite`/etc. are all just PixiJS drawing objects, none of them are transport or
lifecycle concerns.

## Package layout (v2)

| Package                       | Owns                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/state`              | `Snapshot`, `EngineAction`, `Reducer`, `createReducer`, `RawInput`                                                                                                 |
| `packages/engine-client`      | `SyncConfig`, `EntitySyncState`, `applyLocalStep`, `applyRemoteStep` (pure math, no Pixi/DOM)                                                                      |
| `packages/engine-client-pixi` | **New.** `runGame(container, ruleset) -> dispose()` — owns Pixi `Application`, WebSocket client, ticker, raw key capture, calls into `engine-client` + the ruleset |
| `packages/engine-server`      | **New.** `startServer(ruleset, options?)` — owns `Bun.serve`, Hono, WebSocket, room state, broadcast loop                                                          |
| `packages/rulesets/tagtag`    | The `Ruleset` object — entity shape, reducer, `draw`, `mapInput`, `predictStep`, `sync`                                                                            |
| `apps/server`                 | Composition root only: `import { startServer } from "engine-server"; import { tagtag } from "tagtag"; startServer(tagtag)`                                         |
| `apps/client`                 | Composition root only: mounts `runGame(container, tagtag)` in `onMount`                                                                                            |

## What "minimal game code" looks like after this

```ts
// packages/rulesets/tagtag/src/index.ts — the entire game, nothing else needed
export const tagtag: Ruleset<Entity, Action> = {
	createEntity: () => ({ x: 0, y: 0 }),
	reducer: createReducer(...),
	draw: (graphics, entity, isLocal) => {
		graphics.circle(0, 0, isLocal ? 16 : 12)
		graphics.fill(isLocal ? 0x4ade80 : 0x60a5fa)
	},
	mapInput: (input, entityId) => { /* WASD -> MOVE action */ },
	predictStep: (input, dt) => { /* WASD -> per-frame delta */ },
	sync: { predictSpeed: 240, remotePursuitSpeed: 276, snapDistance: 2, freezeDistance: 24 },
}
```

```ts
// apps/server/src/index.ts — the entire server app
import { startServer } from "engine-server"
import { tagtag } from "tagtag"

startServer(tagtag)
```

```svelte
<!-- apps/client/src/lib/Game.svelte — the entire client app -->
<script lang="ts">
	import { onMount } from "svelte"
	import { runGame } from "engine-client-pixi"
	import { tagtag } from "tagtag"

	let container = $state<HTMLDivElement | null>(null)

	onMount(() => {
		if (!container) return
		return runGame(container, tagtag)
	})
</script>

<div bind:this={container} class="game"></div>
```

A second game means writing one ruleset file and changing two import lines (which ruleset each
app boots) — never touching `engine-server`, `engine-client`, or `engine-client-pixi`.

## `startServer` options

Today's `apps/server/src/index.ts` hardcodes `hostname: "0.0.0.0"` and `port: 3000` inside
`Bun.serve`. These aren't ruleset concerns (no game cares what port it runs on) but they also
shouldn't be permanently hardcoded inside `engine-server` — a second app might want a different
port. `startServer` takes an optional second argument:

```ts
type StartServerOptions = {
	port?: number // default 3000
	hostname?: string // default "0.0.0.0" (LAN-accessible, matches today's behavior)
}
```

## Dependency flow after Phase 3

Once 3.1–3.6 land, package dependencies change shape:

- `apps/client`'s `package.json` depends only on `engine-client-pixi` and whichever ruleset(s) it
  boots (`tagtag` today). It no longer directly depends on `engine-client`, `state`, or
  `pixi.js` — those become internal dependencies of `engine-client-pixi`.
- `apps/server`'s `package.json` depends only on `engine-server` and whichever ruleset(s) it
  boots. It no longer directly depends on `state` or `hono` — those become internal dependencies
  of `engine-server`.
- `apps/client/src/App.svelte` and `apps/client/src/main.ts` are unaffected — `Game.svelte`
  remains the mount point Svelte renders, it just delegates its entire body to `runGame`.

## Open questions, still deferred

- Do we need a `removeEntity` hook for rulesets with more complex per-entity cleanup, or is
  "delete from `entities` map" always sufficient? (Default to "always sufficient" until a second
  ruleset proves otherwise.)
- Server-side validation will likely need a ruleset-supplied `validateAction` hook eventually —
  deliberately not designing this now, revisit once server-side robustness work starts.
- How `startServer`/`runGame` pick a ruleset _at runtime_ (vs. compile-time import in the
  composition root) is deliberately out of scope until Phase 4 (multi-room) needs to select
  between multiple rulesets dynamically. For now "change an import line" is an acceptable way to
  switch games — the goal of this phase is that it's the _only_ thing that needs to change.

## History

**v1 → v2 changes and why** (v1 was Phase 1–2's design, implemented and shipped, then found to
have the two gaps described at the top of this document):

1. **Ruleset exports got bundled into one `Ruleset` object.** v1 deferred this ("no place that
   consumes a `Ruleset<T,A>` generically yet"). v2 needs it — `startServer`/`runGame` must take
   "a ruleset" as a single parameter, which requires one object, not five named imports.
2. **`InputState` → `RawInput`.** v1's `InputState` (`up`/`down`/`left`/`right`) baked in a
   directional-movement assumption at the engine level, and `Game.svelte` hardcoded which
   physical keys map to which direction. v2 makes the engine capture only raw key state; a
   ruleset's `mapInput`/`predictStep` do 100% of the interpretation, including physical key
   bindings.
3. **`EntityAppearance` removed, replaced by `draw(graphics, entity, isLocal)`.** v1's
   `{color, radius}` descriptor assumed circular sprites are all any game needs. v2 hands the
   ruleset a real `Graphics` object to draw into — a documented, scoped exception to "ruleset
   never touches Pixi" (see "Where the Pixi exception lives").
4. **New `packages/engine-server` and `packages/engine-client-pixi`.** v1's `apps/server` and
   `apps/client` mixed "the engine" (transport, ticker, broadcast) with "which game is running"
   (a hardcoded `tagtag` import) in the same files. v2 moves all engine logic into packages that
   take a ruleset as a parameter; the apps become minimal composition roots.

`mapInput` taking `entityId`, and the separate `predictStep` hook for 60fps-vs-20Hz timing, both
carry over unchanged from v1 — those were already correct.
