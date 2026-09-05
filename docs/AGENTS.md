# Agents

A coding request is not one job. Finding files is cheap, fast and mechanical;
implementing a change is not. Meridian decomposes the work across specialists
and routes each to a model that suits **its** job and **its** economics.

---

## The roster

| Agent | Job | Mode | Pool | Steps |
| --- | --- | --- | --- | --- |
| Orchestrator | Decides which specialists to run | `BALANCED` | reasoning | 12 |
| Planner | Turns a request into a concrete, file-level plan | `QUALITY_FIRST` | reasoning | 16 |
| File Finder | Locates the files a task touches | `FAST` | fast | 10 |
| Researcher | Answers questions about the code, and public docs when enabled | `BALANCED` | balanced | 14 |
| Browser | Retrieves public pages over HTTP | `CHEAP_FIRST` | fast | 10 |
| Implementer | Writes the code | `QUALITY_FIRST` | coding | 40 |
| Tester | Writes and runs tests | `BALANCED` | coding | 24 |
| Reviewer | Reviews the diff before you see it | `QUALITY_FIRST` | balanced | 16 |
| Debugger | Reproduces and fixes a specific failure | `QUALITY_FIRST` | coding | 30 |

The Browser agent is honest about what it is: an HTTP fetch, not a headless
browser. It does not execute JavaScript, and it says so when a page returns
nothing rather than inventing what the page probably said.

---

## The pipeline is chosen, not fixed

Choosing badly costs money and time, so the shape of the request selects the
pipeline before any expensive model is involved:

| Request looks like | Pipeline |
| --- | --- |
| A question | finder → researcher |
| A reported failure | finder → debugger → tester → reviewer |
| A request for tests | finder → tester → reviewer |
| A small local change | finder → implementer |
| Anything substantive | finder → planner → implementer → tester → reviewer |

Keyword shape is a crude signal but a free one, and it is right often enough
that spending a model call to classify every request would cost more than the
occasional misfire. `POST /api/tasks/estimate` returns the chosen pipeline and
its rationale, and you can override it.

A failure in the finder, planner, implementer or debugger stops the task:
later steps would have nothing to work from, and running them blind burns
budget for no result.

---

## The loop

Each agent runs model turn → tool calls → repeat, bounded by its own step
limit. Two properties matter more than the rest:

- **A tool failure is fed back to the model as a tool result, never thrown.**
  Most real agent turns contain at least one failed call; an exception would
  end the turn, whereas an error the model can read is one it can recover from.
- **The loop is bounded.** A model that gets stuck costs a known amount.

---

## Tools

| Tool | Read-only | Notes |
| --- | --- | --- |
| `read_file` | yes | Line-numbered, with offset and limit |
| `write_file` | no | Records the previous content |
| `edit_file` | no | Exact-string replace; **refuses an ambiguous match** unless `replace_all` |
| `delete_file` | no | Recorded and revertible |
| `list_files`, `glob`, `grep` | yes | Build output and dependencies excluded |
| `run_command` | no | Sandboxed. A non-zero exit is a *result*, not a tool error, so the model debugs rather than retries |
| `git` | no | Fixed command set. No push |
| `show_diff` | yes | Everything changed so far |
| `web_fetch` | yes | Only when web access is enabled |
| `finish` | yes | Ends the turn with a summary |

`edit_file` refusing an ambiguous anchor matters: a model that supplies one is
guessing, and applying the first match silently edits the wrong place.

---

## Nothing is destroyed

Changes are written to disk so tests can run against them, and every write
records the pre-task content on the **first** write to that path. So:

- **Reject** restores the previous bytes exactly; a file the agent created is
  deleted.
- Several edits to one file still revert to the original, not to the previous
  edit.
- The file tree marks changed files, so what an agent touched is visible before
  you open the diff.

---

## Parallel lanes

Several agents can run at once, each in its **own copy** of the workspace.
Isolation is the point: two agents editing one checkout produce a result
neither intended, and the failure is invisible until someone reads the diff.

Lanes are never merged automatically. Each diff is reviewed separately, and
paths that more than one lane touched are reported as overlaps — a
machine-merged combination of two independent agents' edits is exactly the
change a person must look at.

---

## The timeline

Every step reports its status, the model and provider that ran it, latency,
tokens, cost, tool-call count, files touched, and any fallback that occurred.

What it shows is a **concise execution summary** — the agent's own stated
conclusion plus counted facts. Internal reasoning is not surfaced.

---

## Learning

Outcomes feed back into model ranking, from telemetry only:

- Did the call succeed?
- Did the tests the agent ran afterwards pass?
- Did its tool calls parse and execute?
- Did you mark the result good or poor?

Scores are exponentially weighted so recent behaviour dominates, and shrunk
toward neutral until enough samples exist — a model measured three times should
not outrank one measured three hundred times on a lucky run.

**The content of your repository is never part of what is learned.**
