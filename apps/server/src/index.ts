import { existsSync } from "node:fs"
import { join } from "node:path"
import { startServer } from "engine-server"
import { tagtag } from "tagtag"

// In dev, the client's own Vite dev server serves these files; in production (e.g. the Docker
// image built by the root Dockerfile), the client is prebuilt and this process serves it too, so
// one deployed service handles both the static site and the WebSocket API.
const clientDist = join(import.meta.dir, "../../client/dist")

startServer(tagtag, {
	staticDir: existsSync(clientDist) ? clientDist : undefined,
})
