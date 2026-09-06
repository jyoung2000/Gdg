# ---------------------------------------------------------------------------
# Base images.
#
# Overridable because Docker Hub is not reachable everywhere. An operator behind
# a registry policy that blocks it can point these at any Node 22 Debian image
# their organisation does allow — a pull-through mirror, a private registry, or
# a vendor image such as
# mcr.microsoft.com/devcontainers/javascript-node:22-bookworm.
#
#   docker compose build --build-arg BASE_IMAGE=<image> --build-arg RUNTIME_IMAGE=<image>
#
# The steps below install only what the chosen base is actually missing, so a
# fuller image works without reaching a package index at all.
# ---------------------------------------------------------------------------
ARG BASE_IMAGE=node:22-bookworm-slim
ARG RUNTIME_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------------------
# Build stage. The whole monorepo is needed because the gateway bundles the
# workspace packages from source rather than consuming prebuilt artefacts.
# ---------------------------------------------------------------------------
FROM ${BASE_IMAGE} AS build

WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

# Trust anything the operator put in docker/ca/ before reaching the registry.
# An egress proxy that terminates TLS presents its own certificate, and the
# alternative to trusting it explicitly is disabling verification — which is not
# an alternative. Empty by default, in which case this is a no-op.
COPY docker/ca/ /usr/local/share/ca-certificates/meridian-build/
RUN set -eu; \
    if ls /usr/local/share/ca-certificates/meridian-build/*.crt >/dev/null 2>&1 \
    || ls /usr/local/share/ca-certificates/meridian-build/*.pem >/dev/null 2>&1; then \
      for pem in /usr/local/share/ca-certificates/meridian-build/*.pem; do \
        [ -e "$pem" ] && cp "$pem" "${pem%.pem}.crt" || true; \
      done; \
      update-ca-certificates; \
      cat /usr/local/share/ca-certificates/meridian-build/*.crt > /etc/ssl/certs/meridian-build-ca.pem; \
    else \
      : > /etc/ssl/certs/meridian-build-ca.pem; \
    fi
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/meridian-build-ca.pem

RUN corepack enable

# better-sqlite3 falls back to compiling from source when no prebuilt binary
# matches; these are what that fallback needs.
#
# Installed only if the base does not already have them, and verified either
# way: a base that already ships the toolchain must not need a package index it
# may not be able to reach, and a base that is genuinely missing one must fail
# here rather than deep inside a native build.
RUN set -eu; \
    missing=''; \
    for tool in python3 make g++; do command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"; done; \
    if [ -n "$missing" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends $missing ca-certificates \
      && rm -rf /var/lib/apt/lists/*; \
    fi; \
    for tool in python3 make g++; do \
      command -v "$tool" >/dev/null 2>&1 || { echo "required build tool missing and not installable: $tool" >&2; exit 1; }; \
    done

# Manifests and the lockfile first, so a dependency layer is only rebuilt when
# they change. The lockfile is not optional: `--frozen-lockfile` fails outright
# without it, which is the whole point — a build that silently resolved
# different versions than the repository was tested with is worse than one that
# stops.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
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
FROM ${RUNTIME_IMAGE} AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    MERIDIAN_DATA_DIR=/data \
    MERIDIAN_WORKSPACE_ROOT=/workspaces \
    MERIDIAN_WEB_ROOT=/app/dist/web \
    PORT=4639

# git is a first-class dependency: workspaces are clones and the agent commits,
# so a base without it fails here rather than at the first task.
#
# tini reaps the sandbox's child processes, which would otherwise become zombies
# under PID 1. It is preferred but not required — Compose sets `init: true`,
# which gives the same reaping from Docker's own init when tini is absent.
RUN set -eu; \
    need=''; \
    command -v git >/dev/null 2>&1 || need="$need git"; \
    command -v tini >/dev/null 2>&1 || [ -x /usr/bin/tini ] || need="$need tini"; \
    if [ -n "$need" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends $need ca-certificates \
      && rm -rf /var/lib/apt/lists/* \
      || echo "package index unreachable; continuing with what the base image provides" >&2; \
    fi; \
    command -v git >/dev/null 2>&1 || { echo "git is required and is not present in the runtime image" >&2; exit 1; }

# The same certificate trust as the build stage: this stage downloads the Docker
# CLI, and an egress proxy that terminates TLS presents its own certificate here
# too. A no-op when docker/ca/ is empty.
COPY docker/ca/ /usr/local/share/ca-certificates/meridian-build/
RUN set -eu; \
    if ls /usr/local/share/ca-certificates/meridian-build/*.crt >/dev/null 2>&1 \
    || ls /usr/local/share/ca-certificates/meridian-build/*.pem >/dev/null 2>&1; then \
      for pem in /usr/local/share/ca-certificates/meridian-build/*.pem; do \
        [ -e "$pem" ] && cp "$pem" "${pem%.pem}.crt" || true; \
      done; \
      update-ca-certificates; \
      cat /usr/local/share/ca-certificates/meridian-build/*.crt > /etc/ssl/certs/meridian-build-ca.pem; \
    else \
      : > /etc/ssl/certs/meridian-build-ca.pem; \
    fi

# The Docker CLI, so MERIDIAN_SANDBOX=docker can drive the host's daemon through
# the socket Compose mounts. Without it that setting cannot work at all — the
# gateway would start, then fail to spawn `docker` on the first agent command.
#
# Fetched from Docker's own static release server rather than a package index,
# because the runtime base may have neither apt nor curl. It is optional: if the
# download does not succeed the image still builds, and the gateway reports the
# Docker sandbox as unavailable and falls back to the process sandbox with a
# message naming this as the reason.
ARG DOCKER_CLI_VERSION=29.8.0
RUN set -eu; \
    export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/meridian-build-ca.pem; \
    if command -v docker >/dev/null 2>&1; then \
      echo "docker CLI already present"; \
    else \
      arch="$(uname -m)"; \
      case "$arch" in x86_64) dir=x86_64 ;; aarch64|arm64) dir=aarch64 ;; *) dir='' ;; esac; \
      if [ -n "$dir" ] && node -e " \
        const {createWriteStream}=require('fs'); \
        const url='https://download.docker.com/linux/static/stable/'+process.argv[1]+'/docker-'+process.argv[2]+'.tgz'; \
        fetch(url).then(async r=>{ if(!r.ok) throw new Error('HTTP '+r.status); \
          const b=Buffer.from(await r.arrayBuffer()); require('fs').writeFileSync('/tmp/docker.tgz',b); }) \
          .catch(e=>{ console.error(String(e.message||e)); process.exit(1); });" "$dir" "$DOCKER_CLI_VERSION"; then \
        tar -xzf /tmp/docker.tgz -C /tmp docker/docker \
          && install -m 0755 /tmp/docker/docker /usr/local/bin/docker \
          && rm -rf /tmp/docker /tmp/docker.tgz \
          && docker --version; \
      else \
        echo "Docker CLI not installed; MERIDIAN_SANDBOX=docker will report itself unavailable" >&2; \
      fi; \
    fi

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

# tini when the image has it, the process directly when it does not. Compose
# sets `init: true`, so child reaping holds either way; hard-coding the tini path
# would make the image unbuildable on a base that cannot install it.
COPY docker/entrypoint.sh /usr/local/bin/meridian-entrypoint
ENTRYPOINT ["/usr/local/bin/meridian-entrypoint"]
CMD ["node", "dist/gateway/main.js"]
