# Agent verification

The nine specialist agents, what each is wired to do, and what has actually been
observed doing it.

## How these were exercised

`tests/e2e/live-inference.test.ts` runs the real orchestrator against a real
OpenAI-compatible inference server on a real socket. The pipeline is chosen from
the request, each agent's tools are offered to the model, the model's tool calls
come back over the wire, the tools run against a real workspace on disk, and the
files that result are read back off disk rather than taken from a summary.

The inference server is deterministic and rule-based (`scripts/local-model-server.mjs`),
so what these runs verify is the *agent runtime* — tool schemas, the loop, tool
execution, workspace mutation, checkpointing, step sequencing, cancellation,
usage attribution. They verify nothing about how well a real model plans or
writes code, and no row below should be read as saying otherwise.

## Status by agent

| Agent | Task type | Pool | Max steps | Tools | Status |
| --- | --- | --- | --- | --- | --- |
| Orchestrator | planning | reasoning | 12 | read_file, list_files, glob, grep, finish | IMPLEMENTED_UNVERIFIED |
| Planner | planning | reasoning | 16 | read_file, list_files, glob, grep, finish | VERIFIED |
| File Finder | file-search | fast | 10 | list_files, glob, grep, read_file, finish | VERIFIED |
| Researcher | research | balanced | 14 | + web_fetch | IMPLEMENTED_UNVERIFIED |
| Browser | research | fast | 10 | web_fetch, finish | PARTIAL |
| Implementer | coding | coding | 40 | + write_file, edit_file, delete_file, run_command, show_diff | VERIFIED |
| Tester | test | coding | 24 | + write_file, edit_file, run_command | VERIFIED |
| Reviewer | review | balanced | 16 | read_file, show_diff, glob, grep, run_command, finish | VERIFIED |
| Debugger | debug | coding | 30 | + edit_file, write_file, run_command, show_diff | IMPLEMENTED_UNVERIFIED |

**VERIFIED** here means the agent ran as part of a real pipeline, its tool calls
executed, and its effects were observed — for the Implementer and Tester, a file
that exists on disk afterwards.

**Orchestrator, Researcher and Debugger** are IMPLEMENTED_UNVERIFIED because the
pipeline chosen for the requests exercised here did not include them. They share
the same loop, tools and routing path as the agents that were exercised; what is
unverified is their specific instruction and step sequencing, not the machinery
underneath.

**Browser** is PARTIAL. Its refusals are verified — a private, loopback or
metadata address is rejected, a redirect into private space is rejected mid-chain,
a name that resolves into private space is rejected at connect time, and an
oversized body is truncated at the cap (`tests/e2e/security.test.ts`). Its
successful path against a real public page is BLOCKED_EXTERNAL: outbound HTTP
from this environment is filtered, and `web_fetch` is off unless
`MERIDIAN_SANDBOX_NETWORK=true`.

## What a verifying step's verdict means

For a long time, nothing. A command that exits non-zero comes back from
`run_command` as `isError: false` — deliberately, because the model needs to
read the failure and debug rather than retry the tool — and nothing downstream
looked at it. The tester step was recorded as `completed`, the reviewer was told
nothing about it, and the task reported success. **A run where the tests did not
pass was indistinguishable from one where they did.**

That is now wired end to end:

| Stage | Behaviour |
| --- | --- |
| Tool | `ToolResult.exitCode` rides alongside `isError`. "The tool worked" and "the command succeeded" are different facts and only the first was recorded |
| Step | A tester, reviewer or debugger whose commands failed is recorded **failed**, naming the commands and their codes |
| Context | The failure is appended to what the *next* step reads — a reviewer told the tests passed will review a change that does not work |
| Task | Reports the failure rather than completing |
| Learning | The verdict reaches `recordOutcome` as `testsPassed`. This is the only judgement Meridian can make about output quality without a human, and until now the only thing that ever moved a quality score was someone clicking a thumb |
| Escalation | A failing tester appends a debugger and a re-check, **once per task** |

The escalation bound is deliberate. A model that cannot fix its own work in one
attempt will not usually manage it in five, and an unbounded loop here is an
unbounded bill.

A pass is reported as well as a failure. Reporting only failures would bias
every learned score downward.

**Still not implemented:** the reviewer is not required to use a different model
or family from the implementer. `AIRequest` has no field that could express it —
there is no model-family concept in the codebase — and the built-in pools ship
with empty membership, so on a single-provider instance the reviewer is
routinely the same model that wrote the code. What is now true is that its
verdict counts; whose verdict it is remains a gap.

## The runtime around them

| Capability | Status | Evidence |
| --- | --- | --- |
| Pipeline selection from the request | VERIFIED | The coding request produced file-finder → planner → implementer → tester → reviewer |
| Tool schemas offered per agent | VERIFIED | A tool the registry lacks is dropped rather than advertised; `web_fetch` is absent when web access is off |
| Tool-call assembly from streamed fragments | VERIFIED | Arguments split mid-JSON reassemble into the right object |
| Tool failure fed back rather than thrown | VERIFIED | A refused path escape returns to the model as a tool result, and the run continues |
| Workspace containment | VERIFIED | Eight shapes of path escape refused through the API; an agent instructed to read `/etc/passwd` gets a refusal, not the file |
| Change tracking and unified diff | VERIFIED | Writes appear as reviewable changes with a diff; accept and reject both restore exactly |
| Checkpoint per step | VERIFIED | One checkpoint per step, ordered, restorable |
| Rewind | VERIFIED | A rewind removes later work from disk, restores the change log, and discards checkpoints that no longer describe anything |
| Rewind refused mid-run | VERIFIED | A queued or running task cannot be rewound underneath its agent |
| Forking | VERIFIED | A fork gets its own workspace, starts from the original's state, and does not write back into it |
| Parallel lanes | VERIFIED | Three lanes in isolated copies; the inference server observed more than one request open at once |
| Conflict detection across lanes | VERIFIED | Two lanes writing the same path are reported as a conflict |
| Cancellation | VERIFIED | A client disconnect aborts the upstream call; the gateway keeps serving |
| Per-step usage attribution | VERIFIED | Usage rows carry the task id and the agent role that spent them |
| Step budget | IMPLEMENTED_UNVERIFIED | `maxSteps` bounds every agent; no run here reached the ceiling |
| Sandboxed `run_command` | VERIFIED | Against a real container: no network, read-only root, workspace-only writes, a clean environment, and a timeout that fires |

## Sandbox

`tests/e2e/docker-sandbox.test.ts` verifies each isolation guarantee by having a
command inside the container attempt the thing the flag forbids. See
`docs/SECURITY.md` and `docs/evidence/DOCKER.md`.

The one difference from the shipped image: those runs used a minimal image
assembled from host binaries (`scripts/build-sandbox-image.mjs --offline`),
because the real image's base layer cannot be pulled here. The isolation flags,
the mount semantics and the uid the container runs as are identical; the
toolchain inside it is not present.
