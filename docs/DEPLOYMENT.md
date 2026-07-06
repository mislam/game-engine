# Deployment (Railway)

The client and server deploy together as **one Railway service** — no separate frontend host
(e.g. Vercel) is needed. In production, `apps/server` serves the prebuilt client's static files
itself, alongside its `/ws` WebSocket endpoint, so there's a single URL and no cross-origin setup.

## How it works

- `Dockerfile` (repo root) installs dependencies, runs `bun run build` (builds `apps/client` to
  `apps/client/dist`), then starts `apps/server`.
- `apps/server/src/index.ts` checks whether `apps/client/dist` exists. If it does (as it will
  inside the Docker image), it passes it to `startServer` as `staticDir`, which serves it for
  every non-`/ws` request (with an `index.html` SPA fallback). Locally in dev, that directory
  doesn't exist (nothing's built), so the server falls back to its plain-text default — the
  client's own Vite dev server (`:5173`) serves the app instead, same as always.
- The client's WebSocket URL (`packages/engine-client-pixi/src/index.ts`) is dev/prod-aware:
  - **Dev**: `ws://<page-hostname>:3000/ws` — the two dev servers run on different ports.
  - **Prod**: same-origin, protocol-matched — `wss://<host>/ws` when the page is `https:`
    (Railway always serves `https`), so it works no matter what domain Railway assigns.
- The server binds to `process.env.PORT` (falling back to `3000` if unset) — required because
  Railway assigns the port dynamically and injects it via `PORT`.

Nothing about this changes local dev: `bun run dev:server` + `bun run dev:client` still works
exactly as described in the root [`README.md`](../README.md).

## Deploying

**This should be exactly one Railway service** — the root `Dockerfile` builds the client and
starts the server, which serves both.

**Do not use "Deploy from GitHub repo" on the project-creation screen.** That flow runs Railway's
monorepo auto-detector immediately, with no prompt or way to decline, and stages *one service per
`package.json`* it finds — one for `apps/client`, one for `apps/server`. There's nothing to
configure to stop this; it just happens as soon as you pick the repo. The auto-created `client`
service is the wrong shape for this repo: its Root Directory is `apps/client`, so it never sees the
root `Dockerfile`, and it falls back to running `vite preview`/`vite dev` instead — that's what
throws Vite's `Blocked request... allowedHosts` error on that service's domain. Once you're in this
state, delete both auto-created services; there's no salvaging them, since neither one's Root
Directory is the repo root.

Instead, build the project and service manually so nothing gets auto-split:

1. Push this repo to GitHub and go to [railway.app](https://railway.app).
2. **New Project → Empty Project** (*not* "Deploy from GitHub repo").
3. Inside the project, click **+ Create → Empty Service**.
4. Open that service's **Settings → Source**, and connect it to this GitHub repo/branch. Leave
   **Root Directory** at its default (`/`, the repo root) — don't point it at `apps/client` or
   `apps/server`.
5. With the root directory at `/`, Railway will find the root `Dockerfile` and `railway.json`
   (which pins `build.builder` to `DOCKERFILE`) automatically — no manual build/start command
   needed.
6. Under **Settings → Networking**, click **Generate Domain** to get a public
   `https://<name>.up.railway.app` URL. Railway sets `PORT` itself; nothing to configure there.
7. Deploy. Once it's live, open the generated URL in two browser tabs to try the demo, same as the
   [Quick start](../README.md#quick-start) but over the internet instead of `localhost`.

## Testing the production build locally first

You can build and run the exact same image Railway will run, before pushing:

```sh
docker build -t engine .
docker run --rm -p 8080:8080 -e PORT=8080 engine
```

Then open `http://localhost:8080`.

## Notes / limitations

- There's a single global room (see [`ARCHITECTURE.md`](./ARCHITECTURE.md)) — every client that
  connects to the deployed URL joins the same game, with no matchmaking or multiple rooms.
- State is in-memory only; a redeploy or restart resets the game (everyone disconnects and
  reconnects to a fresh room).
- Railway's free tier sleeps/limits usage — fine for trying this out, but not meant for
  always-on production traffic without upgrading.
