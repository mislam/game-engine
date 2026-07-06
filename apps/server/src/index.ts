import { Hono } from "hono"
import { emptySnapshot, type EngineAction, type Snapshot } from "state"
import { reducer, type Action, type Entity } from "tagtag"

type SocketData = {
	entityId: string
}

const app = new Hono()

app.get("/", (c) => c.text("Engine server"))

// Single global room — all state changes go through the ruleset's reducer, then broadcast.
let snapshot: Snapshot<Entity> = emptySnapshot()
const sockets = new Set<ServerWebSocket<SocketData>>()

function apply(action: EngineAction<Action>) {
	snapshot = reducer(snapshot, action)
	const message = JSON.stringify(snapshot)

	for (const ws of sockets) {
		ws.send(message)
	}
}

Bun.serve({
	hostname: "0.0.0.0", // LAN access
	port: 3000,
	fetch(req, server) {
		const url = new URL(req.url)

		if (url.pathname === "/ws") {
			const entityId = crypto.randomUUID()
			const upgraded = server.upgrade(req, { data: { entityId } })

			if (upgraded) return undefined as unknown as Response

			return new Response("WebSocket upgrade failed", { status: 500 })
		}

		return app.fetch(req, server)
	},
	websocket: {
		open(ws) {
			sockets.add(ws)

			const { entityId } = ws.data
			// Wire: WELCOME (own id) then Snapshot broadcast
			ws.send(JSON.stringify({ type: "WELCOME", entityId }))
			apply({ type: "JOIN", entityId })
		},
		message(ws, message) {
			let action: Action

			try {
				action = JSON.parse(String(message))
			} catch {
				return
			}

			// Clients may only MOVE their own entity
			if (action.type !== "MOVE" || action.entityId !== ws.data.entityId) return

			apply(action)
		},
		close(ws) {
			sockets.delete(ws)
			apply({ type: "LEAVE", entityId: ws.data.entityId })
		},
	},
})

console.log("Server listening on http://localhost:3000")
