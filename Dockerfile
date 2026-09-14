# JobAgent monorepo multi-stage Dockerfile
# Each service selects a final stage via docker-compose `target:`
#   docker build --target api -t jobagent-api .
#   docker build --target worker -t jobagent-worker .
#   docker build --target report -t jobagent-report .

FROM node:24-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# ---- Install all workspace dependencies ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/storage/package.json packages/storage/
COPY packages/github-source/package.json packages/github-source/
COPY packages/analyzer-core/package.json packages/analyzer-core/
COPY packages/llm/package.json packages/llm/
COPY packages/job-source/package.json packages/job-source/
COPY packages/ui-tokens/package.json packages/ui-tokens/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/cli/package.json apps/cli/
COPY apps/report/package.json apps/report/
COPY apps/extension/package.json apps/extension/
RUN pnpm install --frozen-lockfile

# ---- Build all workspace packages ----
FROM deps AS build
COPY . .
RUN pnpm -r build

# ---- Shared runtime layer for Node services (api, worker) ----
FROM base AS node-runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps
COPY --from=build /app/package.json ./
COPY --from=build /app/pnpm-workspace.yaml ./
COPY db ./db

# ---- API service ----
FROM node-runtime AS api
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]

# ---- Worker service ----
FROM node-runtime AS worker
CMD ["node", "apps/worker/dist/index.js"]

# ---- Report service (Astro SSR standalone) ----
FROM base AS report
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps
COPY --from=build /app/package.json ./
COPY --from=build /app/pnpm-workspace.yaml ./
COPY db ./db
EXPOSE 4321
CMD ["node", "apps/report/dist/server/entry.mjs"]
