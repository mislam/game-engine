// Generic engine core — no I/O, safe to import in client and server.
// A ruleset supplies its own entity/action shapes; this package only knows the envelope
// (snapshot of entities, lifecycle actions, and how a reducer is wired together).
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

// Generic directional input capture — the engine owns reading keys into this shape;
// a ruleset decides what each direction means (see `mapInput`/`predictStep` conventions).
export type InputState = {
	up: boolean
	down: boolean
	left: boolean
	right: boolean
}

// How a ruleset wants a given entity drawn. Kept intentionally minimal for now —
// extend as more rulesets need more than a colored circle.
export type EntityAppearance = {
	color: number
	radius: number
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
