// Generic multiplayer server: WebSocket transport, wire protocol, connection lifecycle, and the
// single-room snapshot/broadcast loop. Owns everything except "which ruleset" — that's a
// parameter, not an import. See docs/ENGINE_API.md for the engine/ruleset contract.
import { Hono } from "hono"
import { serveStatic } from "hono/bun"
import { emptySnapshot, type EngineAction, type Ruleset, type Snapshot } from "state"

// The server only ever calls a ruleset's `reducer` — `createEntity` is already wrapped into it
// via `createReducer`, and rendering/input hooks are client-side concerns.
type ServerRuleset<TEntity, TAction> = Pick<Ruleset<TEntity, TAction>, "reducer">

export type StartServerOptions = {
	port?: number
	hostname?: string
	// Absolute path to a built static site (e.g. a client's `dist` folder). When set, the server
	// serves it for any non-`/ws` request instead of the plain-text default — this is what lets
	// one process serve both the client and the WebSocket API in a single-service deployment.
	// Left unset in dev, where the client's own dev server (Vite) serves those files instead.
	staticDir?: string
}

const defaultOptions: Required<Omit<StartServerOptions, "staticDir">> = {
	// Railway (and most PaaS hosts) assign the port dynamically via `PORT` — binding to a fixed
	// port would make the deployed container unreachable.
	port: Number(process.env.PORT) || 3000,
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
	const { port, hostname, staticDir } = { ...defaultOptions, ...options }

	const app = new Hono()

	if (staticDir) {
		// SPA fallback: any path that doesn't match a real file (e.g. a client-side route) still
		// resolves to index.html rather than 404ing.
		app.use("*", serveStatic({ root: staticDir }))
		app.use("*", serveStatic({ path: "index.html", root: staticDir }))
	} else {
		app.get("/", (c) => c.text("Engine server"))
	}

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
