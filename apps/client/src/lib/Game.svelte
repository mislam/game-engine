<script lang="ts">
	import { onMount } from "svelte"
	import { Application, Graphics } from "pixi.js"
	import type { InputState, Snapshot } from "state"
	import {
		resolveSyncConfig,
		createSyncState,
		updateAuthority,
		applyLocalStep,
		applyRemoteStep,
		type EntitySyncState,
	} from "engine-client"
	import { mapInput, predictStep, renderEntity, sync, type Entity } from "tagtag"

	// Hostname follows the page URL so LAN clients connect to the dev machine, not themselves.
	const getWsUrl = () => `ws://${window.location.hostname}:3000/ws`

	type WelcomeMessage = {
		type: "WELCOME"
		entityId: string
	}

	type GameSnapshot = Snapshot<Entity>

	type EntityVisual = {
		graphics: Graphics
		sync: EntitySyncState
	}

	let container = $state<HTMLDivElement | null>(null)

	const syncConfig = resolveSyncConfig(sync)

	onMount(() => {
		if (!container) return

		let ws: WebSocket | null = null
		let myEntityId: string | null = null
		let app: Application | null = null
		let inputTimer: ReturnType<typeof setInterval> | null = null

		const entities = new Map<string, EntityVisual>()
		const keys: InputState = { up: false, down: false, left: false, right: false }

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
				const { color, radius } = renderEntity(entity, isMine)

				visual.graphics.clear()
				visual.graphics.circle(0, 0, radius)
				visual.graphics.fill(color)
			}
		}

		const onInputTick = () => {
			if (!ws || ws.readyState !== WebSocket.OPEN || !myEntityId) return

			const action = mapInput(keys, myEntityId)
			if (!action) return

			ws.send(JSON.stringify(action))
		}

		const setKey = (event: KeyboardEvent, pressed: boolean) => {
			switch (event.key.toLowerCase()) {
				case "w":
					keys.up = pressed
					break
				case "s":
					keys.down = pressed
					break
				case "a":
					keys.left = pressed
					break
				case "d":
					keys.right = pressed
					break
				default:
					return
			}

			event.preventDefault()
		}

		const onKeyDown = (event: KeyboardEvent) => setKey(event, true)
		const onKeyUp = (event: KeyboardEvent) => setKey(event, false)

		const init = async () => {
			app = new Application()
			await app.init({
				resizeTo: window,
				background: "#1a1a2e",
				antialias: true,
				resolution: window.devicePixelRatio || 1,
				autoDensity: true,
			})

			container!.appendChild(app.canvas)

			app.ticker.add((ticker) => {
				const dt = ticker.deltaMS / 1000
				const step = predictStep(keys, dt)

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
	})
</script>

<div bind:this={container} class="game"></div>

<style>
	.game {
		width: 100vw;
		height: 100vh;
	}

	.game :global(canvas) {
		display: block;
	}
</style>
