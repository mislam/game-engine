// Generic client-side sync: local prediction, authority reconciliation, and remote-entity
// interpolation. No knowledge of any specific game lives here — see ENGINE_API.md.

export type SyncConfig = {
	inputIntervalMs: number // client -> server send rate (ms)
	predictSpeed: number // local prediction / freeze-catchup speed (units/s)
	remotePursuitSpeed: number // remote entity interpolation speed (units/s)
	snapDistance: number // reconciliation: snap to authority when drift is this close
	freezeDistance: number // reconciliation: hold position when drift exceeds this (avoids bounce-back)
}

// Reasonable defaults for a free-movement, continuously-synced game. A ruleset only needs
// to override the fields it actually cares about via `resolveSyncConfig`.
export const defaultSyncConfig: SyncConfig = {
	inputIntervalMs: 50,
	predictSpeed: 200,
	remotePursuitSpeed: 230,
	snapDistance: 2,
	freezeDistance: 24,
}

export const resolveSyncConfig = (overrides?: Partial<SyncConfig>): SyncConfig => ({
	...defaultSyncConfig,
	...overrides,
})

export type Position = { x: number; y: number }
export type Delta = { dx: number; dy: number }

// Per-entity sync bookkeeping: current rendered position, latest authoritative target/position.
// `target` and `authority` are tracked separately so local reconciliation (which compares
// against authority) stays correct even if a future caller diverges them (e.g. extrapolation).
export type EntitySyncState = {
	x: number
	y: number
	targetX: number
	targetY: number
	authorityX: number
	authorityY: number
}

export const createSyncState = (position: Position): EntitySyncState => ({
	x: position.x,
	y: position.y,
	targetX: position.x,
	targetY: position.y,
	authorityX: position.x,
	authorityY: position.y,
})

// Call when a fresh authoritative snapshot arrives for this entity.
export const updateAuthority = (state: EntitySyncState, position: Position): void => {
	state.targetX = position.x
	state.targetY = position.y
	state.authorityX = position.x
	state.authorityY = position.y
}

// Chase (targetX, targetY) without overshooting.
const pursue = (state: EntitySyncState, dt: number, speed: number): void => {
	const dx = state.targetX - state.x
	const dy = state.targetY - state.y
	const dist = Math.hypot(dx, dy)

	if (dist < 0.1) {
		state.x = state.targetX
		state.y = state.targetY
		return
	}

	const step = speed * dt
	if (step >= dist) {
		state.x = state.targetX
		state.y = state.targetY
	} else {
		state.x += (dx / dist) * step
		state.y += (dy / dist) * step
	}
}

// Local entity: apply a ruleset-predicted per-frame step while moving; when idle, either snap to
// authority (small drift), hold position (moderate drift — avoids bounce-back from server lag),
// or catch up via pursuit (large drift, e.g. after a desync).
export const applyLocalStep = (
	state: EntitySyncState,
	step: Delta,
	dt: number,
	config: SyncConfig,
): void => {
	const moving = step.dx !== 0 || step.dy !== 0

	if (moving) {
		state.x += step.dx
		state.y += step.dy
		return
	}

	const errX = state.authorityX - state.x
	const errY = state.authorityY - state.y
	const err = Math.hypot(errX, errY)

	if (err <= config.snapDistance) {
		state.x = state.authorityX
		state.y = state.authorityY
	} else if (err > config.freezeDistance) {
		pursue(state, dt, config.predictSpeed)
	}
}

// Remote entity: smoothly chase the latest snapshot (no extrapolation).
export const applyRemoteStep = (state: EntitySyncState, dt: number, config: SyncConfig): void => {
	pursue(state, dt, config.remotePursuitSpeed)
}
