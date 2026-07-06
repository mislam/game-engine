// TagTag ruleset: each player controls one dot, moving freely via velocity deltas.
// No engine internals (WebSocket, Pixi, wire protocol) are imported here — see ENGINE_API.md.
import type { SyncConfig } from "engine-client"
import { createReducer, type EntityAppearance, type InputState, type Reducer } from "state"

export type Entity = {
	x: number
	y: number
}

export type Action = { type: "MOVE"; entityId: string; dx: number; dy: number }

export const createEntity = (): Entity => ({ x: 0, y: 0 })

export const reducer: Reducer<Entity, Action> = createReducer(createEntity, (snapshot, action) => {
	const entity = snapshot.entities[action.entityId]
	if (!entity) return snapshot

	return {
		entities: {
			...snapshot.entities,
			[action.entityId]: {
				x: entity.x + action.dx,
				y: entity.y + action.dy,
			},
		},
	}
})

// Movement/sync tuning, collocated with the game that defines what "feels right".
// Only `sync` below is part of the public contract (see ENGINE_API.md) — these are internal
// implementation details consumed by `mapInput`/`predictStep`.
const INPUT_INTERVAL_MS = 50 // 20Hz — matches server broadcast cadence while moving
const MOVE_SPEED = 240 // px/s — local render speed and remote pursuit cap
const MOVE_STEP = MOVE_SPEED * (INPUT_INTERVAL_MS / 1000)
const STOP_SNAP_DISTANCE = 2 // snap to server when stopped and close
const STOP_FREEZE_DISTANCE = 24 // hold position if slightly ahead of server (avoids bounce-back)
const REMOTE_PURSUIT_SPEED = MOVE_SPEED * 1.15

// The engine's generic sync module (`engine-client`) has sensible defaults for all of this;
// TagTag overrides every field here because its movement feel was hand-tuned against these
// exact numbers, not because a ruleset is required to specify all of them.
export const sync: Partial<SyncConfig> = {
	inputIntervalMs: INPUT_INTERVAL_MS,
	predictSpeed: MOVE_SPEED,
	remotePursuitSpeed: REMOTE_PURSUIT_SPEED,
	snapDistance: STOP_SNAP_DISTANCE,
	freezeDistance: STOP_FREEZE_DISTANCE,
}

// What "up/down/left/right" means for TagTag: a normalized free-movement direction.
// The engine only knows which directions are held; TagTag decides how that becomes movement.
const getDirection = (input: InputState): { dx: number; dy: number } => {
	let dx = 0
	let dy = 0

	if (input.up) dy -= 1
	if (input.down) dy += 1
	if (input.left) dx -= 1
	if (input.right) dx += 1

	const length = Math.hypot(dx, dy)
	if (length === 0) return { dx: 0, dy: 0 }

	return { dx: dx / length, dy: dy / length }
}

// Called by the engine at the network send tick to build (or skip) an outgoing action.
export const mapInput = (input: InputState, entityId: string): Action | null => {
	const direction = getDirection(input)
	if (direction.dx === 0 && direction.dy === 0) return null

	return {
		type: "MOVE",
		entityId,
		dx: direction.dx * MOVE_STEP,
		dy: direction.dy * MOVE_STEP,
	}
}

// Called by the engine every rendered frame to predict local movement ahead of the network tick.
export const predictStep = (input: InputState, dt: number): { dx: number; dy: number } => {
	const direction = getDirection(input)
	return { dx: direction.dx * MOVE_SPEED * dt, dy: direction.dy * MOVE_SPEED * dt }
}

// Called by the engine for every entity in a snapshot to decide how to draw it.
export const renderEntity = (_entity: Entity, isLocal: boolean): EntityAppearance => ({
	color: isLocal ? 0x4ade80 : 0x60a5fa,
	radius: isLocal ? 16 : 12,
})
