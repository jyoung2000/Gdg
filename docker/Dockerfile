# ---------------------------------------------------------------------------
# Build stage. The whole monorepo is needed because the gateway bundles the
# workspace packages from source rather than consuming prebuilt artefacts.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# better-sqlite3 falls back to compiling from source when no prebuilt binary
# matches; these are what that fallback needs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Manifests first, so a dependency layer is only rebuilt when they change.
COPY package.json pnpm-workspace.yaml .npmrc ./
COPY apps/gateway/package.json apps/gateway/
COPY apps/web/package.json apps/web/
COPY apps/cli/package.json apps/cli/
COPY packages/shared/package.json packages/shared/
COPY packages/provider-sdk/package.json packages/provider-sdk/
COPY packages/model-sdk/package.json packages/model-sdk/
COPY packages/routing-sdk/package.json packages/routing-sdk/
COPY packages/agent-sdk/package.json packages/agent-sdk/
COPY packages/media-sdk/package.json packages/media-sdk/
COPY packages/ui/package.json packages/ui/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

# ---------------------------------------------------------------------------
# Runtime stage. Only the bundles, the migrations and the production
# dependencies better-sqlite3 needs at runtime.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    MERIDIAN_DATA_DIR=/data \
    MERIDIAN_WORKSPACE_ROOT=/workspaces \
    MERIDIAN_WEB_ROOT=/app/dist/web \
    PORT=4639

# git is a first-class dependency: workspaces are clones and the agent commits.
# tini reaps the sandbox's child processes, which would otherwise become zombies
# under PID 1.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/dist ./dist
COPY --from=build /app/database ./database
COPY --from=build /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=build /app/node_modules/bindings ./node_modules/bindings
COPY --from=build /app/node_modules/file-uri-to-path ./node_modules/file-uri-to-path
COPY package.json ./

# Run as a non-root user. The data and workspace mounts are chowned so a
# volume created by Docker is writable without loosening its permissions.
RUN groupadd --system --gid 1001 meridian \
 && useradd --system --uid 1001 --gid meridian --home /app meridian \
 && mkdir -p /data /workspaces \
 && chown -R meridian:meridian /app /data /workspaces
USER meridian

EXPOSE 4639
VOLUME ["/data", "/workspaces"]

# The gateway serves its own health endpoint, so the check needs no extra tools.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4639)+'/api/system/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/gateway/main.js"]
