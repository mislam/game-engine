// Generic Pixi-based game client: owns the Pixi `Application`, WebSocket connection, ticker
// loop, and raw key capture. No knowledge of any specific game lives here — a ruleset supplies
// entity shape, reducer-adjacent hooks (draw/mapInput/predictStep), and sync tuning. See
// docs/ENGINE_API.md for the engine/ruleset contract.
import { Application, Container, Graphics, Text } from "pixi.js"
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

type EntityVisual<TEntity> = {
	graphics: Graphics
	sync: EntitySyncState
	entity: TEntity
}

// In dev, the client (Vite, :5173) and server (:3000) run as separate processes, so the port is
// hardcoded but the hostname follows the page URL (so LAN clients connect to the dev machine, not
// themselves). In production, the server serves the built client itself (see `apps/server`), so
// the WebSocket lives at the same origin — same host, same port, and `wss:` when the page is
// loaded over `https:` (browsers block plain `ws:` from an `https:` page).
const getWsUrl = () => {
	if (import.meta.env.DEV) return `ws://${window.location.hostname}:3000/ws`

	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
	return `${protocol}//${window.location.host}/ws`
}

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
	let world: Container | null = null
	let titleText: Text | null = null
	let inputTimer: ReturnType<typeof setInterval> | null = null

	const layoutStage = () => {
		if (!app || !world || !ruleset.worldSize) return

		world.x = (app.screen.width - ruleset.worldSize.width) / 2
		world.y = (app.screen.height - ruleset.worldSize.height) / 2

		if (titleText) {
			titleText.x = world.x + ruleset.worldSize.width / 2
			titleText.y = world.y - 12
		}
	}

	const entities = new Map<string, EntityVisual<TEntity>>()
	// One mutable RawInput per session; the same reference is passed into mapInput/predictStep
	// on every call. The engine only tracks which physical keys are held — a ruleset decides
	// what any of them mean (including which keys it cares about at all).
	const keysDown = new Set<string>()
	const input: RawInput = { keysDown }
	// The first snapshot after connecting (including a page refresh) reflects state that already
	// existed before this client joined, not something that just happened — every entity looks
	// "new" (no prior `visual`) purely because this client wasn't here to see it change. Sound
	// is skipped for that one snapshot so pre-existing state (e.g. an already-active tagger)
	// doesn't replay as if it just occurred.
	let hasReceivedSnapshot = false

	const syncSnapshot = (snapshot: GameSnapshot) => {
		if (!app || !world) return

		const isFirstSnapshot = !hasReceivedSnapshot
		hasReceivedSnapshot = true

		const ids = new Set(Object.keys(snapshot.entities))

		for (const [id, visual] of entities) {
			if (ids.has(id)) continue

			world.removeChild(visual.graphics)
			visual.graphics.destroy()
			entities.delete(id)
		}

		for (const [id, entity] of Object.entries(snapshot.entities)) {
			let visual = entities.get(id)
			const prevEntity = visual?.entity

			if (!visual) {
				const graphics = new Graphics()
				graphics.x = entity.x
				graphics.y = entity.y

				visual = { graphics, sync: createSyncState(entity), entity }
				entities.set(id, visual)
				world.addChild(graphics)
			} else {
				updateAuthority(visual.sync, entity)
				visual.entity = entity
			}

			const isMine = id === myEntityId

			// Every client evaluates every entity's transition (not just its own), so a shared
			// event (e.g. a tag) plays the same sound for everyone watching it happen.
			const soundUrl = isFirstSnapshot ? null : ruleset.sound?.(entity, prevEntity, isMine)
			if (soundUrl) void new Audio(soundUrl).play().catch(() => {})

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

		world = new Container()
		app.stage.addChild(world)

		if (ruleset.title) {
			titleText = new Text({
				text: ruleset.title,
				style: {
					fill: 0x4a4a6a,
					fontFamily: "system-ui, -apple-system, sans-serif",
					fontSize: 24,
					fontWeight: "600",
				},
			})
			titleText.anchor.set(0.5, 1)
			app.stage.addChild(titleText)
		}

		layoutStage()
		window.addEventListener("resize", layoutStage)

		app.ticker.add((ticker) => {
			const dt = Math.max(ticker.deltaMS, 1) / 1000
			const step = ruleset.predictStep(input, dt)

			for (const [id, visual] of entities) {
				if (id === myEntityId) {
					applyLocalStep(visual.sync, step, dt, syncConfig)
				} else {
					applyRemoteStep(visual.sync, dt, syncConfig)
				}

				visual.graphics.x = visual.sync.x
				visual.graphics.y = visual.sync.y

				// Re-draw every frame so time-based visuals (cooldown flash, world-anchored
				// shapes) stay smooth; snapshot cadence alone is too slow for animation.
				visual.graphics.clear()
				ruleset.draw(
					visual.graphics,
					{ ...visual.entity, x: visual.sync.x, y: visual.sync.y },
					id === myEntityId,
				)
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
		window.removeEventListener("resize", layoutStage)
		ws?.close()

		for (const visual of entities.values()) {
			visual.graphics.destroy()
		}

		entities.clear()
		app?.destroy(true, { children: true })
	}
}
