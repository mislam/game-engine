// TagTag ruleset: each player controls one dot; one tagger (red) chases the rest.
// No engine internals (WebSocket, Pixi, wire protocol) are imported here — see docs/ENGINE_API.md.
import type { Graphics } from "pixi.js"
import type { SyncConfig } from "engine-client"
import { createReducer, type RawInput, type Reducer, type Ruleset, type Snapshot } from "state"
import gotchaSoundUrl from "../assets/gotcha.wav"

export type Entity = {
	x: number
	y: number
	isTagger: boolean
	tagCooldownUntil: number // ms timestamp — no tag transfers until this time (shared room cooldown)
	color: number // unique player identity color (tagger draws red instead while tagged)
}

export type Action = { type: "MOVE"; entityId: string; dx: number; dy: number }

// Fixed pixel arena — server and clients agree without viewport coupling. Entity centers are
// clamped so dots (radius 16) stay fully inside the playable rectangle.
const ARENA_WIDTH = 960
const ARENA_HEIGHT = 540
const DOT_RADIUS = 16
const ARENA_MIN_X = DOT_RADIUS
const ARENA_MIN_Y = DOT_RADIUS
const ARENA_MAX_X = ARENA_WIDTH - DOT_RADIUS
const ARENA_MAX_Y = ARENA_HEIGHT - DOT_RADIUS
const COLLISION_DISTANCE = DOT_RADIUS * 2
const TAG_COOLDOWN_MS = 3000
const TAGGER_FLASH_INTERVAL_MS = 150

const COLOR_TAGGER = 0xef4444

// Hue-spaced palette (no red / orange / magenta / pink). One perceptual family per slot.
const PLAYER_COLORS = [
	0xfde047, // yellow
	0x22c55e, // green
	0x06b6d4, // cyan
	0x2563eb, // blue
	0x7c3aed, // violet
	0xf8fafc, // white
	0xa3e635, // chartreuse
	0xe2e8f0, // slate (neutral — distinct from chromatic slots)
] as const

const colorDistance = (a: number, b: number): number => {
	const ar = (a >> 16) & 0xff
	const ag = (a >> 8) & 0xff
	const ab = a & 0xff
	const br = (b >> 16) & 0xff
	const bg = (b >> 8) & 0xff
	const bb = b & 0xff
	return Math.hypot(ar - br, ag - bg, ab - bb)
}

const clampPosition = (entity: Entity, x: number, y: number): Entity => ({
	...entity,
	x: Math.max(ARENA_MIN_X, Math.min(ARENA_MAX_X, x)),
	y: Math.max(ARENA_MIN_Y, Math.min(ARENA_MAX_Y, y)),
})

const randomPosition = (): { x: number; y: number } => ({
	x: ARENA_MIN_X + Math.random() * (ARENA_MAX_X - ARENA_MIN_X),
	y: ARENA_MIN_Y + Math.random() * (ARENA_MAX_Y - ARENA_MIN_Y),
})

const createEntity = (): Entity => ({
	...randomPosition(),
	isTagger: false,
	tagCooldownUntil: 0,
	color: 0,
})

const pickUnusedColor = (snapshot: Snapshot<Entity>): number => {
	const used = Object.values(snapshot.entities)
		.map((entity) => entity.color)
		.filter((color) => color !== 0)
	const available = PLAYER_COLORS.filter((color) => !used.includes(color))
	const pool = available.length > 0 ? available : [...PLAYER_COLORS]

	if (used.length === 0) return pool[Math.floor(Math.random() * pool.length)]

	let best = pool[0]
	let bestMinDist = -1

	for (const candidate of pool) {
		const minDist = Math.min(...used.map((color) => colorDistance(candidate, color)))
		if (minDist > bestMinDist) {
			bestMinDist = minDist
			best = candidate
		}
	}

	return best
}

const entityIds = (snapshot: Snapshot<Entity>) => Object.keys(snapshot.entities)

const isTagCooldownActive = (entities: Record<string, Entity>, now = Date.now()) =>
	Object.values(entities).some((entity) => now < entity.tagCooldownUntil)

const clearTaggers = (snapshot: Snapshot<Entity>): Snapshot<Entity> => ({
	entities: Object.fromEntries(
		entityIds(snapshot).map((id) => [id, { ...snapshot.entities[id], isTagger: false }]),
	),
})

// With 2+ players and no tagger, pick one at random — game starts on the second join.
const assignTaggerIfNeeded = (snapshot: Snapshot<Entity>): Snapshot<Entity> => {
	const ids = entityIds(snapshot)
	if (ids.length < 2) return clearTaggers(snapshot)

	if (ids.some((id) => snapshot.entities[id].isTagger)) return snapshot

	const taggerId = ids[Math.floor(Math.random() * ids.length)]
	return {
		entities: Object.fromEntries(
			ids.map((id) => [id, { ...snapshot.entities[id], isTagger: id === taggerId }]),
		),
	}
}

const findTagger = (entities: Record<string, Entity>): string | null => {
	for (const [id, entity] of Object.entries(entities)) {
		if (entity.isTagger) return id
	}
	return null
}

// Closest overlapping non-tagger, used when the tagger is the one who just moved (may have
// multiple victims in range at once).
const findTaggedVictim = (
	entities: Record<string, Entity>,
	taggerId: string,
	tagger: Entity,
): string | null => {
	let closestId: string | null = null
	let closestDist = COLLISION_DISTANCE

	for (const [id, other] of Object.entries(entities)) {
		if (id === taggerId || other.isTagger) continue

		const dist = Math.hypot(other.x - tagger.x, other.y - tagger.y)
		if (dist < closestDist) {
			closestDist = dist
			closestId = id
		}
	}

	return closestId
}

const applyTagTransfer = (
	entities: Record<string, Entity>,
	taggerId: string,
	victimId: string,
): Record<string, Entity> => {
	const tagCooldownUntil = Date.now() + TAG_COOLDOWN_MS
	const transferred = {
		...entities,
		[taggerId]: { ...entities[taggerId], isTagger: false },
		[victimId]: { ...entities[victimId], isTagger: true },
	}

	return Object.fromEntries(
		Object.entries(transferred).map(([id, entity]) => [id, { ...entity, tagCooldownUntil }]),
	)
}

// Runs after any entity's MOVE lands, regardless of whether the mover is the tagger or a
// runner — tagging is symmetric on overlap, not tied to whose action triggered the check.
const resolveTagAfterMove = (
	entities: Record<string, Entity>,
	moverId: string,
	mover: Entity,
): Record<string, Entity> => {
	if (isTagCooldownActive(entities)) return entities

	const taggerId = findTagger(entities)
	if (!taggerId) return entities

	if (moverId === taggerId) {
		const victimId = findTaggedVictim(entities, taggerId, mover)
		return victimId ? applyTagTransfer(entities, taggerId, victimId) : entities
	}

	const tagger = entities[taggerId]
	const dist = Math.hypot(mover.x - tagger.x, mover.y - tagger.y)
	return dist < COLLISION_DISTANCE ? applyTagTransfer(entities, taggerId, moverId) : entities
}

const moveReducer: Reducer<Entity, Action> = createReducer(createEntity, (snapshot, action) => {
	const entity = snapshot.entities[action.entityId]
	if (!entity) return snapshot

	const moved = clampPosition(entity, entity.x + action.dx, entity.y + action.dy)
	const entities = resolveTagAfterMove(
		{ ...snapshot.entities, [action.entityId]: moved },
		action.entityId,
		moved,
	)

	return { entities }
})

const reducer: Reducer<Entity, Action> = (snapshot, action) => {
	if (action.type === "JOIN") {
		const color = pickUnusedColor(snapshot)
		const joined = moveReducer(snapshot, action)
		const withColor = {
			entities: {
				...joined.entities,
				[action.entityId]: { ...joined.entities[action.entityId], color },
			},
		}
		return assignTaggerIfNeeded(withColor)
	}

	if (action.type === "LEAVE") {
		return assignTaggerIfNeeded(moveReducer(snapshot, action))
	}

	return moveReducer(snapshot, action)
}

// Movement/sync tuning, collocated with the game that defines what "feels right".
// Only `sync` below is part of the public contract (see docs/ENGINE_API.md) — these are internal
// implementation details consumed by `mapInput`/`predictStep`.
const INPUT_INTERVAL_MS = 50 // 20Hz — matches server broadcast cadence while moving
const MOVE_SPEED = 240 // px/s — local render speed and remote pursuit cap
const MOVE_STEP = MOVE_SPEED * (INPUT_INTERVAL_MS / 1000)
const STOP_SNAP_DISTANCE = 2 // snap to server when stopped and close
const STOP_FREEZE_DISTANCE = 24 // hold position if slightly ahead of server (avoids bounce-back)
const REMOTE_PURSUIT_SPEED = MOVE_SPEED * 1.15

const sync: Partial<SyncConfig> = {
	inputIntervalMs: INPUT_INTERVAL_MS,
	predictSpeed: MOVE_SPEED,
	remotePursuitSpeed: REMOTE_PURSUIT_SPEED,
	snapDistance: STOP_SNAP_DISTANCE,
	freezeDistance: STOP_FREEZE_DISTANCE,
}

const KEY_UP = "w"
const KEY_DOWN = "s"
const KEY_LEFT = "a"
const KEY_RIGHT = "d"

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

// Client-only render/prediction state, used solely by predictStep/draw below. Deliberately kept
// in one object (rather than scattered `let`s) to make the "single client per page" assumption
// explicit: `runGame` only ever mounts one instance of a ruleset per browser tab today, so a
// module-level singleton is safe, but a ruleset with per-instance state (multiple concurrent
// game mounts, tests) would need this threaded through the engine instead — see docs/ENGINE_API.md.
const clientState = {
	// Local prediction reference point, kept in sync with the arena clamp via `draw`'s drift check.
	predictX: ARENA_WIDTH / 2,
	predictY: ARENA_HEIGHT / 2,
	// Cooldown flash window — synced from snapshots, driven by performance.now() (Safari can
	// coarsen Date.now() during rAF; frame time from predictStep backs up phase).
	lastSeenTagCooldownUntil: 0,
	flashUntilPerf: 0,
	renderTimeMs: 0,
	// Whether we've established a cooldown baseline yet. Without this, the first snapshot this
	// client ever sees (e.g. right after a page refresh, joining mid-cooldown) would look like a
	// fresh tag — `tagCooldownUntil` jumping from the initial 0 to whatever the server already
	// has in flight — and incorrectly kick off a brand new flash window for old news.
	hasCooldownBaseline: false,
}

// Only ever fed the current tagger's own cooldown — never a bystander's. Bystanders (including
// a freshly-joined entity, whose `tagCooldownUntil` defaults to 0) don't share the tagger's
// cooldown value, so letting any entity update this baseline would make the tagger's real,
// still-active cooldown look like a brand new increase the moment a fresh 0 sneaks in first.
const syncClientFlashWindow = (tagger: Entity): void => {
	if (!clientState.hasCooldownBaseline) {
		clientState.hasCooldownBaseline = true
		clientState.lastSeenTagCooldownUntil = tagger.tagCooldownUntil
		return
	}

	if (tagger.tagCooldownUntil > clientState.lastSeenTagCooldownUntil) {
		clientState.lastSeenTagCooldownUntil = tagger.tagCooldownUntil
		clientState.flashUntilPerf = performance.now() + TAG_COOLDOWN_MS
	}
}

const isTaggerInFlashCooldown = (entity: Entity): boolean => {
	if (!entity.isTagger) return false
	syncClientFlashWindow(entity)
	return performance.now() < clientState.flashUntilPerf
}

const predictStep = (input: RawInput, dt: number): { dx: number; dy: number } => {
	clientState.renderTimeMs += Math.max(dt * 1000, 1)

	const direction = getDirection(input)
	const next = clampPosition(
		{ x: 0, y: 0, isTagger: false, tagCooldownUntil: 0, color: 0 },
		clientState.predictX + direction.dx * MOVE_SPEED * dt,
		clientState.predictY + direction.dy * MOVE_SPEED * dt,
	)
	const dx = next.x - clientState.predictX
	const dy = next.y - clientState.predictY
	clientState.predictX = next.x
	clientState.predictY = next.y
	return { dx, dy }
}

const FACE_COLOR = 0x1f2937
const EYE_OFFSET_X = 5
const EYE_OFFSET_Y = -3
const EYE_RADIUS = 1.6
const MOUTH_HALF_WIDTH = 6
const MOUTH_Y = 6
const MOUTH_CURVE = 6 // bow depth off the corner-to-corner line; sign flips smile <-> frown

// A curve through a fixed pair of mouth corners, bowed toward a control point below (smile) or
// above (frown) the corners — one sign flip, instead of separately computed arc angles per mood.
const drawFace = (graphics: Graphics, isSad: boolean): void => {
	graphics.circle(-EYE_OFFSET_X, EYE_OFFSET_Y, EYE_RADIUS)
	graphics.circle(EYE_OFFSET_X, EYE_OFFSET_Y, EYE_RADIUS)
	graphics.fill({ color: FACE_COLOR })

	const curve = isSad ? -MOUTH_CURVE : MOUTH_CURVE
	graphics.moveTo(-MOUTH_HALF_WIDTH, MOUTH_Y)
	graphics.quadraticCurveTo(0, MOUTH_Y + curve, MOUTH_HALF_WIDTH, MOUTH_Y)
	graphics.stroke({ color: FACE_COLOR, width: 1.5 })
}

const entityColor = (entity: Entity): number => {
	if (isTaggerInFlashCooldown(entity)) {
		const phase = Math.floor(clientState.renderTimeMs / TAGGER_FLASH_INTERVAL_MS) % 2
		return phase === 0 ? COLOR_TAGGER : entity.color
	}
	if (entity.isTagger) return COLOR_TAGGER
	return entity.color
}

const draw = (graphics: Graphics, entity: Entity, isLocal: boolean): void => {
	if (isLocal) {
		const drift = Math.hypot(entity.x - clientState.predictX, entity.y - clientState.predictY)
		if (drift > STOP_SNAP_DISTANCE) {
			clientState.predictX = entity.x
			clientState.predictY = entity.y
		}

		const left = ARENA_MIN_X - DOT_RADIUS
		const top = ARENA_MIN_Y - DOT_RADIUS
		const width = ARENA_MAX_X + DOT_RADIUS - left
		const height = ARENA_MAX_Y + DOT_RADIUS - top
		graphics.rect(left - graphics.x, top - graphics.y, width, height)
		graphics.stroke({ color: 0x4a4a6a, width: 1 })
	}

	graphics.circle(0, 0, DOT_RADIUS)
	graphics.fill({ color: entityColor(entity) })
	drawFace(graphics, entity.isTagger)
}

// Fires only for an actual catch (`applyTagTransfer`), not an administrative tagger assignment
// (`assignTaggerIfNeeded`, e.g. the second join, or re-picking a tagger after a solo dip caused
// by a disconnect/reconnect). The two are indistinguishable by `isTagger` flipping true alone —
// both do that — but only a real tag bumps `tagCooldownUntil`; an administrative assignment
// leaves it untouched. Every client evaluates every entity, so everyone hears a real tag.
const sound = (next: Entity, prev: Entity | undefined): string | null => {
	const justTagged = next.isTagger && next.tagCooldownUntil > (prev?.tagCooldownUntil ?? 0)
	return justTagged ? gotchaSoundUrl : null
}

export const tagtag: Ruleset<Entity, Action, Graphics> = {
	createEntity,
	reducer,
	draw,
	mapInput,
	predictStep,
	sound,
	sync,
	worldSize: { width: ARENA_WIDTH, height: ARENA_HEIGHT },
	title: "Tag-Tag",
}
