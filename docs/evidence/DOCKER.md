# Docker verification evidence

Captured 2026-09-07 during the final hardening pass. Supersedes the earlier
BLOCKED_EXTERNAL record: the gate has now been **run**, not inferred.

## What was executed, in order

```
docker compose config                       VALID
docker compose build meridian               SUCCESS  (see "Registry access" below)
docker compose --profile build-sandbox \
  build sandbox-image                       SUCCESS  (meridian-sandbox:latest)
docker compose up -d meridian               Up (healthy) in ~8s
GET  /                                      200, web client served
GET  /api/system/ready                      ready: true — database, discovery, models
POST /v1/chat/completions                   completion from the discovered local server
POST /anthropic/v1/messages (stream)        typed event stream, 7 events
POST /api/workspaces                        workspace created on the bind mount
POST /api/tasks                             pipeline completed; persist.md exists on the host
POST /api/workspaces/:id/exec               ran inside a THROWAWAY SANDBOX CONTAINER
                                            (container hostname in uname output)
docker compose down && up -d                state intact afterwards:
                                            workspaces, credential (hint '••••2333'),
                                            task history, models, sandbox: docker
claude -p ... (Claude Code 2.1.263)         completed a turn against the containerized
                                            gateway's Anthropic surface
```

The sandbox state inside the container is `docker`, undegraded: the image ships
the static Docker CLI, Compose mounts the socket with the daemon's group id, and
`MERIDIAN_WORKSPACE_HOST_ROOT` translates workspace paths for the host daemon.
The startup probe verified the mount both ways before claiming any of that.

## The defects running this gate exposed (all fixed)

1. **The Dockerfile never copied `pnpm-lock.yaml`**, so `pnpm install
   --frozen-lockfile` failed for everyone, everywhere. The build had never
   succeeded as shipped.
2. **The gateway crashed at boot under the shipped Compose defaults**: with
   `MERIDIAN_SANDBOX=docker` and no `docker` CLI in the image, the sandbox
   probe's spawn failure propagated out of startup instead of degrading. The
   probe now converts every failure into a diagnosis, and the image carries the
   CLI.
3. **Models persisted in the volume outlived their provider**: after a restart
   the router rejected every candidate with "provider is not registered".
   Orphaned models are now dropped at load; discovery re-adds them when the
   endpoint answers.
4. **A workspace mount not owned by the gateway's uid** degraded with a message
   naming the exact directory and errno — which is the intended behaviour, and
   matches the ownership step `.env.example` documents.

## Registry access

This environment's egress policy answers 403 for Docker Hub's blob CDN and for
Debian's package mirrors, so the default base image (`node:22-bookworm-slim`)
cannot be pulled here. Per policy those denials are respected, not routed
around. `mcr.microsoft.com` IS permitted, so the gate ran with the documented
overrides:

```
MERIDIAN_BASE_IMAGE=mcr.microsoft.com/devcontainers/javascript-node:22-bookworm
MERIDIAN_RUNTIME_IMAGE=$MERIDIAN_BASE_IMAGE
MERIDIAN_SANDBOX_BASE_IMAGE=$MERIDIAN_BASE_IMAGE
MERIDIAN_BUILD_NETWORK=host           # the build reaches npm through the host
docker/ca/agent-proxy.crt             # the TLS-terminating proxy's CA, trusted at build time
```

Every one of these is a first-class, documented mechanism (docker/Dockerfile,
docker/ca/README.md, docker-compose.yml), because "my registry is not Docker
Hub" and "my egress proxy terminates TLS" are ordinary enterprise conditions,
not special cases of this environment.

**Precisely stated:** the Compose deployment is VERIFIED on a Node 22 Debian
bookworm base from an alternate registry. The same Dockerfiles with the default
Docker Hub base are IMPLEMENTED_UNVERIFIED here — nothing about them differs
except which registry serves the first layer.
