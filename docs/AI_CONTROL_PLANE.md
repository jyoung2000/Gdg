# The AI control plane

How Meridian decides what each AI can do, what it is given, and how it says
why. This document covers model discovery, capability provenance, skills, MCP
grants, assignment precedence, effective configuration, and connections.

## The one rule worth learning

Skills and MCP servers are assigned at a **scope**, and the most specific scope
with an opinion wins:

```
global  <  provider  <  model  <  profile  <  workspace  <  session
```

An assignment is three-valued, which is what makes the interesting case
expressible:

| Mode | Meaning |
| --- | --- |
| `include` | On at this scope. |
| `exclude` | Off at this scope, **overriding anything broader**. |
| *(absent)* | No opinion — inherit from a broader scope. |

So "on for everything except this one model" is a global `include` plus a
model-scoped `exclude`. The global rule is never edited, and every other model
keeps inheriting it. The API expresses "no opinion" as `mode: "inherit"`, which
deletes the assignment rather than storing a third state.

Every resolution records the chain that produced it, and the API returns the
sentence the UI shows — for example *“Excluded by model "openai:gpt-4o"
assignment, overriding 1 broader assignment(s)”*. If you cannot explain why a
skill is active, that is a bug.

## Capability provenance

A capability is never a bare assertion. Each one carries how it was
established:

| State | Meaning |
| --- | --- |
| `probe_verified` | A real request proved it. |
| `user_confirmed` | An operator asserted it deliberately. |
| `provider_declared` | The provider's own listing said so. |
| `inferred` | Derived from the model's name. A guess, labelled. |
| `unsupported` | Established as *not* supported. |
| `unknown` | Nobody has said anything. |

Two consequences the UI depends on:

- **`unknown` is not `unsupported`.** An absence of information is rendered as
  an absence of information.
- **Stronger evidence wins and is never downgraded.** A discovery pass that
  re-infers `vision` from a model name cannot overwrite an operator's
  confirmation. Capability search ranks proven support above a guess and says
  so in its reasons.

Confirm or deny a capability with `POST /api/models/:id/capabilities`; the
change is audited.

## Skills

A skill is instruction text injected into the model's system context when it
resolves as active. Because that cost is paid on **every** request the skill
resolves for, each skill carries a token estimate, and the effective-config
view reports the total and the share of the model's context it consumes.

A skill may declare `requiresCapabilities`. If the resolved model lacks one,
the skill is reported **blocked with the reason** rather than silently dropped
— spending context telling a text-only model to read images is a
misconfiguration the operator needs to see.

Meridian seeds five builtin skills on an empty install so precedence can be
exercised immediately. They are ordinary skills: editable and deletable.

## Effective configuration

`GET /api/runtime/effective-config` returns exactly what an AI will be given,
and the runtime calls the same resolver on every request. There is one
implementation, so the settings screen and the model can never disagree.

The response includes active skills with their reasons, inactive ones with
either their inheritance or the reason they are blocked, MCP grants, the skill
token total, and context pressure.

## Discovery

Discovery asks each configured provider for its own model listing; the listing
is the authority, so a pass **removes** models a provider no longer serves.
Each pass diffs against the previous set and records `discovered`, `updated`
and `removed` events, which is what makes "recently discovered" an observation
rather than a render-time guess.

Discovery is paced per provider: a minimum interval, exponential backoff with
jitter after a failure, and a pause after repeated failures. `POST
/api/models/discover` with `{"force": true}` bypasses the interval — but not a
short floor, so holding down a refresh button cannot become a request storm.
Skipped providers are reported in the response rather than hidden.

## Connections

`GET /api/connections` states in words what each connection grants. An API key
is described as API-billed access and is **never** presented as a consumer
subscription, because those are different things and the user is paying for one
of them. Local providers are described as running on your own hardware.

Meridian stores credentials with its existing encrypted credential store;
secrets never appear in listings, logs, or events.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET/POST/PATCH/DELETE /api/skills` | Skill CRUD |
| `POST /api/skills/import`, `GET /api/skills/export` | Portable skill content (no ids, no credentials) |
| `GET /api/assignments`, `PUT /api/assignments` | Scoped assignments (`include`/`exclude`/`inherit`) |
| `GET/POST/PATCH/DELETE /api/ais` | AI profiles |
| `GET /api/runtime/effective-config` | Resolved configuration with explanations |
| `POST /api/runtime/capability-search` | Find an AI by what it can do |
| `GET/POST /api/models/:id/capabilities` | Capability evidence; operator confirmation |
| `POST /api/models/discover` | Manual discovery (`force` to bypass pacing) |
| `GET /api/models/changes` | Discovery history |
| `GET /api/models/discovery-status` | Per-provider pacing state |
| `GET /api/connections` | What each provider connection grants |

Reads require the `workspaces` scope; writes are administrative, because an
assignment silently changes what every future request is given.

## Adding a provider

Discovery is adapter-based. Implement `listModels` on a provider adapter in
`packages/provider-sdk`; the normalized descriptors flow through `enrich()`,
which records provenance, and into the same registry everything else reads. No
part of the control plane needs to change.

## Troubleshooting

**A skill is not reaching the model.** Open Skills → Effective config and pick
the model. Every skill is listed as active with its reason, or inactive with
its inheritance or block reason.

**A model is missing from capability search.** It is returned with
`eligible: false` and the reason — a missing capability, a context length below
the minimum, or unavailability. Nothing is silently filtered out.

**A capability looks wrong.** Check its state in the inspector. `inferred`
means Meridian guessed from the name; confirm or deny it to record the truth.

**Discovery is not picking up a new model.** Check
`/api/models/discovery-status`. A provider may be inside its minimum interval
or backing off after failures; force a refresh from the AI screen.
