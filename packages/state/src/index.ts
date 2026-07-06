// Generic engine core — no I/O, safe to import in client and server.
// A ruleset supplies its own entity/action shapes; this package only knows the envelope
// (snapshot of entities, lifecycle actions, and how a reducer is wired together).
import type { Delta, SyncConfig } from "engine-client"

export type Snapshot<TEntity> = {
	entities: Record<string, TEntity>
}

// Lifecycle actions the engine itself issues on connect/disconnect. A ruleset's own
// action union is layered on top of these via EngineAction.
export type LifecycleAction =
	{ type: "JOIN"; entityId: string } | { type: "LEAVE"; entityId: string }

export type EngineAction<TAction> = LifecycleAction | TAction

export type Reducer<TEntity, TAction> = (
	snapshot: Snapshot<TEntity>,
	action: EngineAction<TAction>,
) => Snapshot<TEntity>

export const emptySnapshot = <TEntity>(): Snapshot<TEntity> => ({ entities: {} })

// Purely mechanical: which physical keys are currently held. No semantic meaning (no "up"/
// "down") — that interpretation is entirely a ruleset's job via `mapInput`/`predictStep`. Keys
// are normalized via `KeyboardEvent.key.toLowerCase()` (e.g. "w", "a", "arrowup"). The engine
// owns exactly one mutable `RawInput` per game session and passes the same reference into
// `mapInput`/`predictStep` on every call — `ReadonlySet` is a type-level "don't mutate this from
// a ruleset" signal, not a guarantee of a fresh object each call.
export type RawInput = {
	keysDown: ReadonlySet<string>
}

// The full plugin boundary a ruleset implements, bundled into one object (docs/ROADMAP.md 3.1) so
// engine packages (engine-server, engine-client-pixi, added in 3.2/3.3) can take "a ruleset" as
// a single parameter instead of a grab-bag of named imports. `TGraphics` defaults to `unknown`
// here so this package never needs a Pixi dependency; `engine-client-pixi` (and any ruleset it
// hosts) specialize it to Pixi's real `Graphics` type. See docs/ENGINE_API.md for the full contract.
export type Ruleset<TEntity, TAction, TGraphics = unknown> = {
	createEntity: (entityId: string) => TEntity
	reducer: Reducer<TEntity, TAction>

	// Given a Graphics-like object (already positioned by the engine, already cleared), draw
	// this entity into it. Called once per entity every time a snapshot arrives (server broadcast
	// cadence), not every rendered frame. Must be idempotent: safe to call repeatedly with the
	// same entity. This is a documented, scoped exception to "ruleset never touches Pixi" — see
	// docs/ENGINE_API.md -> "Where the Pixi exception lives".
	draw: (graphics: TGraphics, entity: TEntity, isLocal: boolean) => void

	// Interpret raw input into a wire action (called at the network tick rate), or null if idle.
	mapInput: (input: RawInput, entityId: string) => TAction | null

	// Interpret raw input into a local per-frame displacement (called every rendered frame).
	predictStep: (input: RawInput, dt: number) => Delta

	// Optional — when set, the Pixi client centers this world rectangle in the viewport.
	worldSize?: { width: number; height: number }

	// Optional — displayed above the arena (requires `worldSize` for positioning).
	title?: string

	// Optional — given an entity's previous state (undefined if it just joined) and current
	// state, return a sound asset URL to play, or null. Called once per entity every time a
	// snapshot arrives (not every rendered frame), for every entity (not just the local one) —
	// so every client hears the same shared events. A ruleset detects "what happened" itself by
	// diffing prev/next (e.g. a boolean flag turning true); the engine has no notion of what any
	// transition means, it only knows how to load and play an audio URL.
	sound?: (next: TEntity, prev: TEntity | undefined, isLocal: boolean) => string | null

	// Optional — engine has defaults for every field.
	sync?: Partial<SyncConfig>
}

// Wraps a ruleset's reducer with default JOIN/LEAVE handling, so a ruleset only
// has to implement the action cases it actually cares about.
export function createReducer<TEntity, TAction extends { type: string }>(
	createEntity: (entityId: string) => TEntity,
	customReducer: (snapshot: Snapshot<TEntity>, action: TAction) => Snapshot<TEntity>,
): Reducer<TEntity, TAction> {
	return (snapshot, action) => {
		if (action.type === "JOIN" || action.type === "LEAVE") {
			const lifecycleAction = action as LifecycleAction

			if (lifecycleAction.type === "JOIN") {
				return {
					entities: {
						...snapshot.entities,
						[lifecycleAction.entityId]: createEntity(lifecycleAction.entityId),
					},
				}
			}

			const { [lifecycleAction.entityId]: _, ...entities } = snapshot.entities
			return { entities }
		}

		return customReducer(snapshot, action as TAction)
	}
}
