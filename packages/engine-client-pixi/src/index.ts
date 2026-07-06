// Generic Pixi-based game client: owns the Pixi `Application`, WebSocket connection, ticker
// loop, and raw key capture. No knowledge of any specific game lives here — a ruleset supplies
// entity shape, reducer-adjacent hooks (draw/mapInput/predictStep), and sync tuning. See
// ENGINE_API.md for the engine/ruleset contract.
import { Application, Graphics } from "pixi.js"
import type { RawInput, Ruleset, Snapshot } from "state"
import {
	applyLocalStep,
	applyRemoteStep,
	createSyncState,
	resolveSyncConfig,
	updateAuthority,
	type EntitySyncState,
} from "engine-client"

type Position = { x: number; y: number }
type WireAction = { type: string; entityId: string }

type WelcomeMessage = {
	type: "WELCOME"
	entityId: string
}

type EntityVisual = {
	graphics: Graphics
	sync: EntitySyncState
}

// Hostname follows the page URL so LAN clients connect to the dev machine, not themselves.
const getWsUrl = () => `ws://${window.location.hostname}:3000/ws`

// Mounts a game into `container`, connecting to the engine server and running it until the
// returned dispose function is called (e.g. from a Svelte `onMount` cleanup).
export function runGame<TEntity extends Position, TAction extends WireAction>(
	container: HTMLElement,
	ruleset: Ruleset<TEntity, TAction, Graphics>,
): () => void {
	type GameSnapshot = Snapshot<TEntity>

	const syncConfig = resolveSyncConfig(ruleset.sync)

	let ws: WebSocket | null = null
	let myEntityId: string | null = null
	let app: Application | null = null
	let inputTimer: ReturnType<typeof setInterval> | null = null

	const entities = new Map<string, EntityVisual>()
	// One mutable RawInput per session; the same reference is passed into mapInput/predictStep
	// on every call. The engine only tracks which physical keys are held — a ruleset decides
	// what any of them mean (including which keys it cares about at all).
	const keysDown = new Set<string>()
	const input: RawInput = { keysDown }

	const syncSnapshot = (snapshot: GameSnapshot) => {
		if (!app) return

		const ids = new Set(Object.keys(snapshot.entities))

		for (const [id, visual] of entities) {
			if (ids.has(id)) continue

			app.stage.removeChild(visual.graphics)
			visual.graphics.destroy()
			entities.delete(id)
		}

		for (const [id, entity] of Object.entries(snapshot.entities)) {
			let visual = entities.get(id)

			if (!visual) {
				const graphics = new Graphics()
				graphics.x = entity.x
				graphics.y = entity.y

				visual = { graphics, sync: createSyncState(entity) }
				entities.set(id, visual)
				app.stage.addChild(graphics)
			} else {
				updateAuthority(visual.sync, entity)
			}

			const isMine = id === myEntityId

			// The engine clears before handing off — a ruleset's `draw` always draws onto a
			// blank Graphics, it never needs to clear first.
			visual.graphics.clear()
			ruleset.draw(visual.graphics, entity, isMine)
		}
	}

	const onInputTick = () => {
		if (!ws || ws.readyState !== WebSocket.OPEN || !myEntityId) return

		const action = ruleset.mapInput(input, myEntityId)
		if (!action) return

		ws.send(JSON.stringify(action))
	}

	// The engine only captures which keys are held, physically — it has no notion of what any
	// key means, so (unlike the old per-key WASD switch) it can't selectively preventDefault
	// only the keys a game cares about. Browser shortcuts (refresh, devtools, etc.) keep working.
	const onKeyDown = (event: KeyboardEvent) => keysDown.add(event.key.toLowerCase())
	const onKeyUp = (event: KeyboardEvent) => keysDown.delete(event.key.toLowerCase())

	const init = async () => {
		app = new Application()
		await app.init({
			resizeTo: window,
			background: "#1a1a2e",
			antialias: true,
			resolution: window.devicePixelRatio || 1,
			autoDensity: true,
		})

		container.appendChild(app.canvas)

		app.ticker.add((ticker) => {
			const dt = ticker.deltaMS / 1000
			const step = ruleset.predictStep(input, dt)

			for (const [id, visual] of entities) {
				if (id === myEntityId) {
					applyLocalStep(visual.sync, step, dt, syncConfig)
				} else {
					applyRemoteStep(visual.sync, dt, syncConfig)
				}

				visual.graphics.x = visual.sync.x
				visual.graphics.y = visual.sync.y
			}
		})

		ws = new WebSocket(getWsUrl())

		ws.onmessage = (event) => {
			const message = JSON.parse(event.data) as WelcomeMessage | GameSnapshot

			// Snapshot has no `type` field; WELCOME does
			if ("type" in message) {
				if (message.type === "WELCOME") {
					myEntityId = message.entityId
				}
				return
			}

			syncSnapshot(message)
		}

		window.addEventListener("keydown", onKeyDown)
		window.addEventListener("keyup", onKeyUp)
		inputTimer = setInterval(onInputTick, syncConfig.inputIntervalMs)
	}

	void init()

	return () => {
		if (inputTimer) clearInterval(inputTimer)
		window.removeEventListener("keydown", onKeyDown)
		window.removeEventListener("keyup", onKeyUp)
		ws?.close()

		for (const visual of entities.values()) {
			visual.graphics.destroy()
		}

		entities.clear()
		app?.destroy(true, { children: true })
	}
}
