// TagTag ruleset: each player controls one dot, moving freely via velocity deltas.
// No engine internals (WebSocket, Pixi, wire protocol) are imported here — see ENGINE_API.md.
import type { Graphics } from "pixi.js"
import type { SyncConfig } from "engine-client"
import { createReducer, type RawInput, type Reducer, type Ruleset } from "state"

export type Entity = {
	x: number
	y: number
}

export type Action = { type: "MOVE"; entityId: string; dx: number; dy: number }

const createEntity = (): Entity => ({ x: 0, y: 0 })

const reducer: Reducer<Entity, Action> = createReducer(createEntity, (snapshot, action) => {
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
const sync: Partial<SyncConfig> = {
	inputIntervalMs: INPUT_INTERVAL_MS,
	predictSpeed: MOVE_SPEED,
	remotePursuitSpeed: REMOTE_PURSUIT_SPEED,
	snapDistance: STOP_SNAP_DISTANCE,
	freezeDistance: STOP_FREEZE_DISTANCE,
}

// TagTag's own key bindings — the engine has no notion of "up"/"down", so a ruleset owns 100%
// of the interpretation, including which physical keys mean what.
const KEY_UP = "w"
const KEY_DOWN = "s"
const KEY_LEFT = "a"
const KEY_RIGHT = "d"

// Turns held keys into a normalized free-movement direction.
const getDirection = (input: RawInput): { dx: number; dy: number } => {
	let dx = 0
	let dy = 0

	if (input.keysDown.has(KEY_UP)) dy -= 1
	if (input.keysDown.has(KEY_DOWN)) dy += 1
	if (input.keysDown.has(KEY_LEFT)) dx -= 1
	if (input.keysDown.has(KEY_RIGHT)) dx += 1

	const length = Math.hypot(dx, dy)
	if (length === 0) return { dx: 0, dy: 0 }

	return { dx: dx / length, dy: dy / length }
}

// Called by the engine at the network send tick to build (or skip) an outgoing action.
const mapInput = (input: RawInput, entityId: string): Action | null => {
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
const predictStep = (input: RawInput, dt: number): { dx: number; dy: number } => {
	const direction = getDirection(input)
	return { dx: direction.dx * MOVE_SPEED * dt, dy: direction.dy * MOVE_SPEED * dt }
}

// Called by the engine for every entity in a snapshot, given a blank (already-positioned,
// already-cleared) Graphics object to draw into — the one documented spot a ruleset touches Pixi.
const draw = (graphics: Graphics, _entity: Entity, isLocal: boolean): void => {
	graphics.circle(0, 0, isLocal ? 16 : 12)
	graphics.fill(isLocal ? 0x4ade80 : 0x60a5fa)
}

// The entire game, bundled into one object per ENGINE_API.md — nothing engine-owned reaches
// into these pieces individually; `engine-server`/`engine-client-pixi` (ROADMAP.md 3.2/3.3) take
// this whole object as their "which ruleset" parameter.
export const tagtag: Ruleset<Entity, Action, Graphics> = {
	createEntity,
	reducer,
	draw,
	mapInput,
	predictStep,
	sync,
}
