# Context optimization

Doing more with less context, without losing the information that matters.

## The problem, measured

An agent's transcript grows by an assistant turn and a tool result every pass,
and the whole thing is re-sent on every turn. By turn forty, a run that reads
one file repeatedly is paying for thirty-nine copies of output it has finished
with. Measured on the benchmark fixture: **93,136 prompt tokens**, of which
about 2,500 are doing any work.

Nothing in Meridian trimmed that. There was no truncation, no compaction, no
relevance selection, and no token budget anywhere — only a handful of unrelated
fixed character caps on individual strings, none of which knew what window the
prompt was headed for. `AIRequest.contextLength` existed and the router filtered
on it, but no production caller ever set it, so the router could not reject a
model for being too small for the payload it was about to receive.

## The shape

```
measure  →  select  →  transform  →  verify  →  report
```

Measurement comes first so the "before" number is taken from the untouched
prompt. Verification comes last **and can undo the whole thing**.

### Measure

`packages/shared/src/tokens.ts` replaced three divergent character heuristics
(`/3.7` in two places, `/4` in a third) with one estimator that counts what
actually goes on the wire: message framing, tool schemas, and — the one that
mattered most — images.

The old estimator read a message list as
`typeof content === 'string' ? content : ''`, so a request carrying ten
screenshots estimated at **zero prompt tokens**, fitted any window and cleared
any budget. An image is the densest thing a prompt can carry.

`breakdownTokens()` attributes a request to where its tokens came from, because
"31k tokens" tells an operator nothing they can act on and "18k of it is tool
schemas" tells them exactly what to change.

### Select

Skills and tool schemas are the two things most often attached "just in case"
and then serialised on every call. Selection scores them against the request by
term overlap, weighted toward rarer words.

**This is lexical, not semantic, and that is a deliberate trade.** Embedding
every skill and every request would cost a model call to decide what to put in a
model call, and an optimiser that spends more than it saves is a loss however
elegant. The consequence is that selection is biased hard toward inclusion:

| Rule | Effect |
| --- | --- |
| Operator enabled it explicitly | Always included, never scored |
| Under 200 tokens | Always included — not worth the risk of deciding wrongly |
| ≥ 8% term overlap | Included |
| Otherwise | Excluded, with the reason recorded |

A wrongly included skill costs tokens. A wrongly excluded one costs the answer.

### Transform

Three transforms, each pure and independently tested:

- **Deduplicate.** Byte-identical content appearing twice is replaced by a
  marker at the earlier position. The *later* copy survives, because in an agent
  loop the newest read is the current truth and a stale copy of a since-edited
  file is worse than no copy.
- **Elide stale tool results.** Recent results keep their full body; older ones
  keep a recognisable head plus a count of what was dropped.
- **Window history.** Drops turns from the middle. Anchored and never dropped:
  every system message, the first user message, and the most recent turns.

The history marker is **not a summary**. Summarising needs a model call, and a
fabricated summary of dropped content is worse than an honest gap.

### Verify

The optimised prompt is compared against the original before it is sent. This is
what makes the rest safe to run: the failure mode of a context optimiser is
silent — the request succeeds, the answer is subtly wrong, and nothing reports a
problem. A model cannot tell you about the constraint it was never shown.

Four guarantees:

1. There is still a user message.
2. The **first and most recent** user messages survive byte for byte.
3. Every requirement-shaped token from *any* user message — a filename, a
   backticked identifier, a quoted string, a URL — is still present somewhere.
4. At least one system message survives.

A failure does not warn. It **falls back to a gentler mode** and retries, down
to `OFF` if necessary, and the report says it happened.

Guarantee 2 is deliberately not "every user message". The first version of this
required exactly that, and the benchmark caught what it cost: windowing a
forty-turn conversation necessarily drops old turns, so every attempt failed the
check and fell back, and long chats reported a **0% saving**. Guarantee 3 is
what makes relaxing it safe — `windowHistory` hoists the references a dropped
turn named into the marker it leaves behind, so the prose goes and the
requirement stays.

## Modes

| Mode | Removes |
| --- | --- |
| `OFF` | Nothing |
| `CONSERVATIVE` | Only provably redundant content — byte-identical duplicates |
| `BALANCED` | + stale tool results, history windowing, skill selection |
| `AGGRESSIVE` | + narrower windows, and tool filtering |

`AUTO` picks from how full the window already is: below 25% pressure it does
nothing, then conservative, balanced at 50%, aggressive at 80%.

Two things are deliberately reserved for `AGGRESSIVE`. Tool filtering changes
what the model is *able to do*, not merely what it knows — a different kind of
change from dropping stale output, and one that deserves its own opt-in.

## What it actually saves

Measured, not projected — `pnpm exec tsx scripts/benchmark-context.mjs`. Full
table in [TOKEN_OPTIMIZATION_BENCHMARK.md](TOKEN_OPTIMIZATION_BENCHMARK.md).

| Fixture | Before | After (BALANCED) | Saved |
| --- | ---: | ---: | ---: |
| Short chat | 520 | 520 | 0% — *skipped* |
| Agent, 6 turns on one file | 5,702 | 1,174 | 79% |
| Agent, 20 turns | 31,196 | 1,790 | 94% |
| Long chat, no repetition | 9,928 | 1,067 | 89% |
| Agent, 40 turns | 93,136 | 2,560 | 97% |
| 8 screenshots | 6,658 | 6,658 | 0% |

Every row passes the independent safety check.

Two of those rows are the honest ones. **The short chat is skipped entirely**:
below 1,500 tokens the optimiser declines, because trimming a small prompt saves
nothing anyone notices and carries the same risk as trimming a large one. **The
screenshot request saves nothing** — eight distinct images cannot be
deduplicated and there is no history to window. An optimiser that always reports
a saving is one that is sometimes making things worse.

Optimisation costs 0.02–7.5ms, against savings of tens of thousands of tokens.

## Where it runs

The agent loop, per turn (`packages/agent-sdk/src/loop.ts`). That is where
context genuinely runs away, and per-turn rather than once at the start because
the transcript grows as the step proceeds.

It runs in `AUTO`, so a short step is left completely alone. `AgentRunResult`
carries `contextTokensSaved`, summed from a real before/after measurement on
each turn rather than from what any stage believed it saved.

## Not implemented, and why

- **Semantic retrieval.** Relevance is lexical. Stated above rather than
  implied.
- **Model-generated summaries** of dropped history. Would need a call per
  optimisation; the honest gap marker is cheaper and cannot hallucinate.
- **Prompt caching.** No `cache_control` is emitted and the cached-token counts
  providers return are parsed and discarded. `Usage` has no cached-token field
  and `Pricing` has no cached-input rate, so a saving could not be expressed
  even if measured. Worth noting the current assembly order prepends the most
  volatile content first, which is exactly backwards for prefix caching.
- **Two-pass context building** (a cheap model deciding what the expensive model
  should see). The lexical path was built first precisely because it costs
  nothing; a second pass has to beat "free" to be worth adding.
- **The gateway chat surfaces.** Optimisation is wired into the agent loop only.
  The OpenAI and Anthropic surfaces still assemble context additively, and the
  three assembly paths have not yet been unified.
