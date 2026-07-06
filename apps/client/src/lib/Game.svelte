<script lang="ts">
	import { onMount } from "svelte"
	import { Application, Graphics } from "pixi.js"
	import type { Action, Snapshot } from "state"

	// Hostname follows the page URL so LAN clients connect to the dev machine, not themselves.
	const getWsUrl = () => `ws://${window.location.hostname}:3000/ws`
	const INPUT_INTERVAL_MS = 50 // 20Hz — matches server broadcast cadence while moving
	const MOVE_SPEED = 240 // px/s — local render speed and remote pursuit cap
	const MOVE_STEP = MOVE_SPEED * (INPUT_INTERVAL_MS / 1000)
	const STOP_SNAP_DISTANCE = 2 // snap to server when stopped and close
	const STOP_FREEZE_DISTANCE = 24 // hold position if slightly ahead of server (avoids bounce-back)
	const REMOTE_PURSUIT_SPEED = MOVE_SPEED * 1.15

	type WelcomeMessage = {
		type: "WELCOME"
		entityId: string
	}

	type EntityVisual = {
		graphics: Graphics
		x: number
		y: number
		targetX: number
		targetY: number
		authorityX: number
		authorityY: number
	}

	let container = $state<HTMLDivElement | null>(null)

	// Chase latest snapshot position without overshooting (used for remote entities).
	const pursue = (visual: EntityVisual, dt: number, speed: number) => {
		const dx = visual.targetX - visual.x
		const dy = visual.targetY - visual.y
		const dist = Math.hypot(dx, dy)

		if (dist < 0.1) {
			visual.x = visual.targetX
			visual.y = visual.targetY
			return
		}

		const step = speed * dt
		if (step >= dist) {
			visual.x = visual.targetX
			visual.y = visual.targetY
		} else {
			visual.x += (dx / dist) * step
			visual.y += (dy / dist) * step
		}
	}

	onMount(() => {
		if (!container) return

		let ws: WebSocket | null = null
		let myEntityId: string | null = null
		let app: Application | null = null
		let inputTimer: ReturnType<typeof setInterval> | null = null

		const entities = new Map<string, EntityVisual>()
		const keys = { up: false, down: false, left: false, right: false }

		const getInputDirection = () => {
			let dx = 0
			let dy = 0

			if (keys.up) dy -= 1
			if (keys.down) dy += 1
			if (keys.left) dx -= 1
			if (keys.right) dx += 1

			return { dx, dy }
		}

		const syncSnapshot = (snapshot: Snapshot) => {
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

					visual = {
						graphics,
						x: entity.x,
						y: entity.y,
						targetX: entity.x,
						targetY: entity.y,
						authorityX: entity.x,
						authorityY: entity.y,
					}

					entities.set(id, visual)
					app.stage.addChild(graphics)
				} else {
					visual.targetX = entity.x
					visual.targetY = entity.y
					visual.authorityX = entity.x
					visual.authorityY = entity.y
				}

				const isMine = id === myEntityId
				const color = isMine ? 0x4ade80 : 0x60a5fa
				const radius = isMine ? 16 : 12

				visual.graphics.clear()
				visual.graphics.circle(0, 0, radius)
				visual.graphics.fill(color)
			}
		}

		const sendMove = (dx: number, dy: number) => {
			if (!ws || ws.readyState !== WebSocket.OPEN || !myEntityId) return

			const action: Action = { type: "MOVE", entityId: myEntityId, dx, dy }
			ws.send(JSON.stringify(action))
		}

		const onInputTick = () => {
			const { dx: rawDx, dy: rawDy } = getInputDirection()
			if (rawDx === 0 && rawDy === 0) return

			const length = Math.hypot(rawDx, rawDy)
			sendMove((rawDx / length) * MOVE_STEP, (rawDy / length) * MOVE_STEP)
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
			})

			container!.appendChild(app.canvas)

			app.ticker.add((ticker) => {
				const dt = ticker.deltaMS / 1000
				const { dx: rawDx, dy: rawDy } = getInputDirection()
				const moving = rawDx !== 0 || rawDy !== 0

				for (const [id, visual] of entities) {
					if (id === myEntityId) {
						// Local: 60fps WASD; on stop, freeze unless desync is large
						if (moving) {
							const length = Math.hypot(rawDx, rawDy)
							visual.x += (rawDx / length) * MOVE_SPEED * dt
							visual.y += (rawDy / length) * MOVE_SPEED * dt
						} else {
							const errX = visual.authorityX - visual.x
							const errY = visual.authorityY - visual.y
							const err = Math.hypot(errX, errY)

							if (err <= STOP_SNAP_DISTANCE) {
								visual.x = visual.authorityX
								visual.y = visual.authorityY
							} else if (err > STOP_FREEZE_DISTANCE) {
								pursue(visual, dt, MOVE_SPEED)
							}
						}
					} else {
						// Remote: smooth 20Hz snapshots via pursuit (no extrapolation)
						pursue(visual, dt, REMOTE_PURSUIT_SPEED)
					}

					visual.graphics.x = visual.x
					visual.graphics.y = visual.y
				}
			})

			ws = new WebSocket(getWsUrl())

			ws.onmessage = (event) => {
				const message = JSON.parse(event.data) as WelcomeMessage | Snapshot

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
			inputTimer = setInterval(onInputTick, INPUT_INTERVAL_MS)
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
