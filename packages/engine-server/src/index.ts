// Generic multiplayer server: WebSocket transport, wire protocol, connection lifecycle, and the
// single-room snapshot/broadcast loop. Owns everything except "which ruleset" — that's a
// parameter, not an import. See ENGINE_API.md for the engine/ruleset contract.
import { Hono } from "hono"
import { emptySnapshot, type EngineAction, type Ruleset, type Snapshot } from "state"

// The server only ever calls a ruleset's `reducer` — `createEntity` is already wrapped into it
// via `createReducer`, and rendering/input hooks are client-side concerns.
type ServerRuleset<TEntity, TAction> = Pick<Ruleset<TEntity, TAction>, "reducer">

export type StartServerOptions = {
	port?: number
	hostname?: string
}

const defaultOptions: Required<StartServerOptions> = {
	port: 3000,
	hostname: "0.0.0.0", // LAN access
}

type SocketData = {
	entityId: string
}

type WireAction<TAction> = { type: string; entityId: string } & TAction

export function startServer<TEntity, TAction extends { type: string; entityId: string }>(
	ruleset: ServerRuleset<TEntity, TAction>,
	options?: StartServerOptions,
) {
	const { port, hostname } = { ...defaultOptions, ...options }

	const app = new Hono()
	app.get("/", (c) => c.text("Engine server"))

	// Single global room — all state changes go through the ruleset's reducer, then broadcast.
	let snapshot: Snapshot<TEntity> = emptySnapshot()
	const sockets = new Set<Bun.ServerWebSocket<SocketData>>()

	function apply(action: EngineAction<TAction>) {
		snapshot = ruleset.reducer(snapshot, action)
		const message = JSON.stringify(snapshot)

		for (const ws of sockets) {
			ws.send(message)
		}
	}

	const server = Bun.serve<SocketData>({
		hostname,
		port,
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
				apply({ type: "JOIN", entityId } as EngineAction<TAction>)
			},
			message(ws, message) {
				let action: WireAction<TAction>

				try {
					action = JSON.parse(String(message))
				} catch {
					return
				}

				// Clients may only act on their own entity, and may never send lifecycle actions
				// directly — JOIN/LEAVE are engine-issued only (on connect/disconnect).
				if (action.type === "JOIN" || action.type === "LEAVE") return
				if (action.entityId !== ws.data.entityId) return

				apply(action as TAction)
			},
			close(ws) {
				sockets.delete(ws)
				apply({ type: "LEAVE", entityId: ws.data.entityId } as EngineAction<TAction>)
			},
		},
	})

	console.log(`Server listening on http://localhost:${server.port}`)

	return server
}
