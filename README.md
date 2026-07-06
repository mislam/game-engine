# Game Engine

_A pluggable, genre-agnostic multiplayer game engine — shared state sync, client-side prediction,
and WebSocket transport, with games plugged in as a single object._

**TagTag**, a small real-time tag game, is the reference application built on top of it — proof
that a game can plug in without the engine knowing anything about tagging, colors, or dots.

![TagTag demo](https://github.com/user-attachments/assets/c7c1bf7b-36b2-46be-881b-63a788d30ec0)

## What is this?

The engine (`packages/state`, `engine-client`, `engine-client-pixi`, `engine-server`) owns
everything genre-agnostic: connection lifecycle, snapshot broadcast, client-side prediction and
reconciliation, rendering plumbing, and raw input capture. None of it knows what a "game" is — it
just takes a **ruleset**: one plain object bundling a game's entity shape, reducer, rendering
hook, input mapping, and tuning. Swapping which game runs is a one-line import change in the
composition-root apps, with zero edits under any `packages/engine-*` package.

**TagTag** (`packages/rulesets/tagtag`) is the first ruleset built against this contract, and
currently the only app running on the engine: everyone controls a dot, one dot is "it" (red, sad
face 😢), and touching them passes it on to you.

## Try the demo (TagTag)

1. Open the client in two or more browser tabs (or on multiple devices over LAN).
2. Move with **WASD**.
3. Once a second player joins, one of you is randomly picked as the tagger (red, sad face).
   Everyone else gets a happy face and their own color.
4. Touch the tagger (or have them touch you) to pass "it" on — there's a 3-second cooldown after
   each tag, during which the tagger flashes.
5. Playing solo pauses the chase — you'll need a friend (or another tab) to actually get tagged.

## Quick start

Requires [Bun](https://bun.sh).

```sh
bun install

bun run dev:server   # http://localhost:3000
bun run dev:client   # http://localhost:5173
```

Open the client URL in two tabs and start moving — that's the whole demo.

### Playing over LAN

Both dev servers bind to all interfaces, so other devices on the same network can join at
`http://<host-machine-ip>:5173`. The client figures out the WebSocket URL from the page's
hostname automatically — no config needed.

## Project structure

| Package                       | Role                                                            |
| ------------------------------ | ----------------------------------------------------------------- |
| `packages/state`              | Generic engine core (shared types, reducer helper)               |
| `packages/engine-client`      | Generic client-side prediction/reconciliation math                |
| `packages/engine-client-pixi` | Generic Pixi rendering client (WebSocket, ticker, input)          |
| `packages/engine-server`      | Generic Bun/WebSocket multiplayer server                          |
| `packages/rulesets/tagtag`    | The example game: entity shape, rules, rendering, sound           |
| `apps/client`                 | Composition root — mounts the Pixi client with `tagtag`          |
| `apps/server`                 | Composition root — boots the server with `tagtag`                |

The four `packages/engine-*`/`state` packages never import or reference `tagtag` (or any
ruleset) by name — a game is always just an object handed to the engine at the composition root.
See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for a full package-by-package walkthrough.

## Tech stack

Bun workspaces · Bun + Hono + native WebSocket (server) · Vite + Svelte + PixiJS (client) ·
TypeScript throughout.

## Learn more

- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — how every package fits together, the wire
  protocol, and what TagTag's rules actually do
- [`docs/ENGINE_API.md`](./docs/ENGINE_API.md) — the formal engine ↔ ruleset contract (what a new
  game needs to implement to plug in)
- [`docs/ROADMAP.md`](./docs/ROADMAP.md) — what's built, what's next, and why it's sequenced that
  way
