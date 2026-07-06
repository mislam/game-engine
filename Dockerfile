FROM oven/bun:1.3.14-slim AS base
WORKDIR /app

# Install deps first so this layer stays cached as long as lockfiles/manifests don't change.
FROM base AS deps
COPY package.json bun.lock ./
COPY apps/client/package.json apps/client/package.json
COPY apps/server/package.json apps/server/package.json
COPY packages/state/package.json packages/state/package.json
COPY packages/engine-client/package.json packages/engine-client/package.json
COPY packages/engine-client-pixi/package.json packages/engine-client-pixi/package.json
COPY packages/engine-server/package.json packages/engine-server/package.json
COPY packages/rulesets/tagtag/package.json packages/rulesets/tagtag/package.json
RUN bun install --frozen-lockfile

FROM base AS build
COPY --from=deps /app /app
COPY . .
RUN bun run build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 3000
CMD ["bun", "run", "start"]
