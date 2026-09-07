# Model-agnostic computer agent — implementation report

## Implementation summary

Meridian can now hand a model this machine's screen, pointer and keyboard, under
a permission system the backend enforces itself and a kill switch that actually
kills.

The design decision that matters most is what is *not* there: no table mapping a
model to an agent implementation. The model layer and the computer layer meet in
exactly one function — a planner that turns a screenshot into an ordinary
Meridian model call and turns the reply back into a normalized action. Because
that is the whole coupling, any vision-capable model can drive any available
backend, and there is nowhere a hard-coded pairing could hide even if someone
wanted to add one.

Computer control is off unless a session exists. There is no setting that leaves
it armed, no background process holding the display, and no default that hands a
model control. That is enforced rather than asserted: probing backend health
starts the X helper, reads the screen geometry and shuts it down again, so an
idle gateway has no process able to synthesise keystrokes.

Ten defects were found by running the thing rather than reading it, and fixed.
The most serious is described under *Manual verification* below: Stop reported
success while the helper process kept running, because the loop awaited the
model on an AbortController the session could not reach.

## Meridian files changed

**New — `packages/computer-sdk/`** (the whole package)

| File | What it is |
| --- | --- |
| `src/types.ts` | Action protocol, permissions, screen context, `toScreenPoint`, event types |
| `src/policy.ts` | Validate → permission → risk → approval. The security core. |
| `src/session.ts` | State machine, approval gate, `runOp` kill switch, history, registry |
| `src/loop.ts` | Observe/plan/act, repetition detection, plan parsing |
| `src/routing.ts` | Capability-based model choice with reasons; grounding selection |
| `src/backend.ts` | The backend interface, registry, `abortableSleep` |
| `src/backends/native.ts` | X11 desktop via a helper process |
| `src/backends/browser.ts` | A browser viewport as a computer surface |
| `src/backends/external.ts` | Agent-S and UI-TARS detection |
| `src/diagnostics.ts` | Six live checks against a real backend |
| `helper/xagent.py` | The audited X11 input/capture helper |

**New — gateway**

- `apps/gateway/src/services/computer.ts` — the service, and the planner that is
  the entire model↔backend coupling
- `apps/gateway/src/routes/computer.ts` — the HTTP API
- `database/migrations/007_computer_agent.sql` — sessions and actions

**New — UI, tests, docs**

- `apps/web/src/screens/ComputerScreen.tsx`
- `tests/e2e/computer-agent.test.ts`, `tests/unit/computer.test.ts`
- `docs/COMPUTER_AGENT.md`

**Modified**

- `apps/gateway/src/services/app.ts` — construction and shutdown
- `apps/gateway/src/db/store.ts` — session and action persistence
- `apps/gateway/src/server.ts`, `services/events.ts` — routes and the event stream
- `apps/web/src/screens/ChatScreen.tsx` — Agent Mode in the composer
- `apps/web/src/screens/SettingsScreen.tsx` — Computer control section
- `apps/web/src/lib/api.ts`, `lib/store.ts`, `shell/App.tsx` — client and nav
- `apps/cli/src/uag.ts` — `uag computer …`
- `packages/browser-sdk/src/{provider,playwright,manager}.ts` — coordinate primitives
- `packages/shared/src/config.ts` — grounding and start URL as real config
- `packages/ui/src/icons/icons.tsx` — one icon
- `tests/ui/screens.test.ts` — the screen list was stale; now exhaustive

## Upstream integrations

No upstream application is vendored, copied or forked. What was taken is design,
and each borrowing is cited in the file that uses it.

| Project | What was used |
| --- | --- |
| [Agent-S](https://github.com/simular-ai/Agent-S) | The planner/grounder separation, and the `--grounding_width`/`--grounding_height` convention that `ScreenContext` follows. Its input path (`pyautogui` over XTest) is the same layer `xagent.py` drives. |
| [UI-TARS Desktop](https://github.com/bytedance/UI-TARS-desktop) | The operator abstraction, and specifically treating a browser and a desktop as peer surfaces rather than one being a lesser substitute. Its `scaleX`/`scaleY` handling is the same coordinate problem `toScreenPoint` solves. |

Both are also registered as *backends* — `agent-s` and `ui-tars` — whose health
checks run the real binaries. Those checks are real; the adapters are not
written, and `open()` says so rather than pretending. See *Known limitations*.

## New GUI

**Computer screen** (`work` section, between Browser and Version Control):

- A status card that is the loudest thing on the page: either "Computer agent:
  off — nothing is watching or driving this machine", or "A model is controlling
  this computer right now" with a **Stop everything** button.
- Backends, probed live, each with its screen geometry — and, when unavailable,
  the reason and what would fix it.
- A task builder: model (Auto or any vision-capable model), backend, privacy
  preference, step limit, approval mode. **Preview what Auto would choose** runs
  the router without starting anything and prints its reasons.
- **Run diagnostics** — six checks against the live backend.
- A permissions panel, grouped as a person thinks about them rather than
  alphabetically, with the presets served from the gateway so a button can never
  grant something different from what it says.
- A live session view: the screenshot the model is looking at, the action
  timeline with each action's status and risk, the granted permissions shown
  beside what the session is doing, and Pause / Resume / Stop.
- A non-dismissible approval dialog naming the action concretely — "Move the
  pointer to 777, 555" — with **Deny**, **Allow once**, and **Allow for this
  task** (which is withheld entirely for destructive actions).
- Session history, including the actions that were refused.

**Chat composer**: an Agent Mode selector offering *Normal AI* and *Computer
agent*. It defaults to Normal AI on every visit and is deliberately not
remembered. Choosing computer mode and pressing Enter does not hand over
control — it opens a confirmation naming exactly what the session will and will
not be allowed to do.

**Settings → Computer control**: reports whether anything is running right now,
which backends could act and why the rest cannot, and states the two things that
are not configurable — nothing is granted in advance, and destructive actions
always ask.

## Models

Any model in Meridian's registry that reports vision. Nothing is hard-coded:
there is no list of "supported computer-use models" anywhere in the tree.

Auto picks by capability and returns its reasoning as sentences:

- Vision is required. A model without it is refused **by name, with the reason**.
- Confirmed vision outranks provider-declared vision, which outranks vision
  inferred from a model's name — and the explanation says which it was.
- `local_only` filters to local models and errors if there are none. It never
  falls back to a hosted model: a screenshot of your desktop is not something to
  send somewhere you did not choose.
- It does not take the first model in the list; that is asserted by a unit test
  in which the first candidate is available but blind.

Fallback retries **planning only**. An action that already reached the machine is
never replayed because the next model call failed.

## Agent backends

| Backend | Surface | State |
| --- | --- | --- |
| `native` | This machine's desktop, X11 XTest + Pillow | Working, verified against a real display |
| `browser` | A browser page as the screen | Working |
| `agent-s` | Agent-S | Detected only — adapter not written |
| `ui-tars` | UI-TARS | Detected only — adapter not written |

Every backend is always listed. One that cannot run appears as unavailable with
a reason and a remediation, never absent.

A browser session gets its own page, so several can run at once. The desktop has
one surface, so a second concurrent native session is refused by name.

## Grounding

Models point in a normalized space; Meridian scales onto the real screen.

```
MERIDIAN_GROUNDING_WIDTH=1000
MERIDIAN_GROUNDING_HEIGHT=1000
```

Both must be set together — half a grounding space would scale one axis and not
the other, so a partial setting is ignored rather than half-applied. Unset, the
model is asked to point in real pixels.

This is now part of the config surface rather than read from `process.env` deep
in a service, which is how it came to be silently ignored before.

## Permissions

Sixteen, granted individually, defaulting to none:

```
screen  mouse  keyboard  clipboard  open_application  browser  terminal
files_read  files_write  files_delete  files_download  files_upload
mcp  docker  network  remote_computer
```

Presets: `readOnly` (`screen` alone) and `safe` (`screen`, `mouse`, `keyboard`,
`open_application`).

**The backend enforces these, not the model.** The model is told its permissions
so it plans sensibly, and told plainly that Meridian enforces them regardless.
The order in `evaluate()` is deliberate: a malformed action is rejected before
its permission is considered, and a permission it does not hold is rejected
before its risk is weighed — so a denied action never appears in an approval
dialog, which would invite the user to grant something the session was
configured not to have.

Unrecognised permission names in a request are dropped rather than stored, so a
typo cannot look like a grant.

Risk is read from what an action would do. Destructive actions ask in every
approval mode including `autonomous`, and "allow for this task" never applies to
them.

## MCP and skills

A session's model calls carry the skills the AI control plane resolves for that
model, through `skillPrompt` — the same resolution path the rest of Meridian
uses, so a skill assigned to a model reaches its computer sessions too.

`mcp` is a permission like any other, denied by default. It is not granted by
the safe preset.

## Tests

| Suite | Result |
| --- | --- |
| `tests/unit/computer.test.ts` | **32/32 pass** |
| `tests/unit` (whole suite) | **125/125 pass** |
| `tests/e2e/computer-agent.test.ts` | **10/10 pass** |
| `tests/ui/screens.test.ts` | **25/25 pass** — all 18 screens, 3 viewports, both themes |
| `tsc --noEmit` (whole monorepo) | clean |

The E2E suite runs against a real gateway and a real inference server. Its cases:

1. is off by default and says so
2. reports every backend, and explains the ones that are unavailable
3. refuses to hand a computer to a model that does not report vision
4. explains what Auto chose rather than just naming it
5. refuses an action outside the granted permissions, at the gateway
6. holds an action at the approval gate and never runs a denied one
7. stops a session blocked inside a model call, and releases its backend
8. cancels a long wait instead of letting it run out
9. records the owner, the outcome and the refusals in the database
10. moves a real pointer to the scaled coordinate

Case 10 skips itself without an X display rather than reporting a pass it did
not earn.

The UI suite's screen list had gone stale — seven screens added since it was
written were never opened in a browser, including this one. Making it exhaustive
immediately caught a navigation bug in the Version Control screen's test path.
One caveat, stated rather than glossed: the suite opens each screen's default
view, so the new Settings → Computer control section is covered for compilation
and for the screen rendering, but its own panel is not clicked through.

## Manual verification

Everything below was run against a live gateway with a real X display
(`Xvfb :99`, 1280×800), the real Python helper, and a real local inference
server. Nothing is asserted from reading the code.

**Real pointer control.** A session drove the pointer to 222,333 and later to
640,320, both confirmed by querying the X server with `XQueryPointer` rather
than trusting the session's own report. The second also confirms scaling: the
model emitted 500,400 in a 1000×1000 space and the pointer landed on 640,320 on
a 1280×800 screen.

**Permission enforcement.** A session granted `screen` only proposed a `type`
action. Result: `status: denied`, `verdict: reject`, reason `This session does
not have the "keyboard" permission`. The keystroke never reached the machine.

**Approval gating.** A session in `every_action` mode proposed a pointer move and
entered `awaiting_approval` with the description "Move the pointer to 777, 555".
**The pointer was still at 10,10 while the approval was pending**, confirmed
against the X server — proving the action had not run. Denying returned
`{"denied": true}`, the pointer was still at 10,10 afterwards, and the action
recorded `status: denied, error: "denied by the user"`.

**Stop, against a model that never answers.** With the inference server told to
accept the request and never reply, the session parked inside the model call.

- *Before the fix:* Stop returned `stopped` — and the helper process was still
  alive **twelve seconds later**, still holding an X connection with synthetic
  input capability. The loop awaited the planner on a controller the session
  could not reach.
- *After the fix:* Stop took effect in **under a second** and the helper was
  gone, verified by process listing. No error was recorded, because a deliberate
  stop is not a failure.

**Stop during a 45-second wait.** Returned in **10ms**; the action recorded "the
action was cancelled or timed out" rather than running to completion.

**A SIGKILLed gateway leaves no orphan.** A process opened the native backend and
was `SIGKILL`ed with no chance to clean up. The helper was gone within three
seconds, because it asks the kernel for `PR_SET_PDEATHSIG`.

**A health probe leaves nothing running.** The process count before and after
probing native health is identical.

**A full run leaves nothing behind.** After the E2E suite completes, the process
exits with code 0 and the count of X helper processes is zero. This is asserted
by observation rather than by `--test-force-exit`: the suite hanging after every
test passed was the symptom that led to defects 9, 10 and 11, and forcing an
exit would have hidden all three.

**Repetition.** A model proposing the same move three times stopped the session
at step 2 of 8 with an accurate reason, rather than burning the step budget.

**Persistence.** A finished session's row carries its state, summary, end time,
owner and config snapshot; its actions are stored with their verdicts.

## Defects found and fixed

Found by exercising the system, not by review. The last three were found only
because the test runner refused to exit after every test had passed — a symptom
easy to paper over with a force-exit flag, and worth chasing instead:

1. **Stop did not stop.** Only action execution was under the kill switch, so a
   Stop during a model call left the request in flight and the helper alive.
   Every long call now runs through `session.runOp`.
2. **`wait` was uninterruptible.** A 45-second sleep the kill switch could not
   reach.
3. **Health probes leaked a helper process** for the life of the gateway.
4. **A SIGKILLed gateway orphaned its helper**, which kept X input capability.
5. **Sessions were world-readable and world-approvable.** Live sessions were
   returned, paused and approved with no ownership check.
6. **Finished sessions persisted incomplete rows** — `finishedAt` and `summary`
   were assigned after the state change that writes the row.
7. **Grounding never reached the backend**, so coordinate scaling silently
   defaulted to identity.
8. **One backend instance was shared across sessions**, so one session's close
   pulled the surface out from under another.
9. **Diagnostics opened the backend and never closed it**, so every diagnostics
   run left an X helper running behind a UI saying nothing was.
10. **The gateway left a Chromium process running on every shutdown.** The
    browser manager closed its sessions but never the browser itself, so a
    restart accumulated one per cycle. Found because it kept the test runner
    alive after every test had passed.
11. **Helper shutdown was not total.** A health probe and a session open could
    interleave such that two helpers existed while only one was tracked, and
    shutdown killed only the tracked one.

## Known limitations

- **Agent-S and UI-TARS are detected, not driven.** Health checks are real and
  the remediation text is accurate; `open()` throws honestly. The adapter
  between Meridian's action protocol and their agent loops is not written.
- **One display.** X reports a multi-head setup as one large screen, and that is
  what the agent sees. `singleDisplayOnly` is `true` and the UI says so. There
  is no display picker and none is implied.
- **A container cannot drive the host desktop.** With no reachable display the
  native backend reports unavailable with the reason. The host-agent transport
  that would make it possible is not built, and no privileged Docker flags are
  required (or would help).
- **The browser surface cannot launch or close applications**, and cannot scroll
  horizontally. Those actions are absent from its supported list, so a plan
  proposing one is refused rather than attempted.
- **The native backend cannot close applications.** There is no safe general
  mechanism; the error says to use a window-manager hotkey.
- **Finished sessions are held in memory for fifteen minutes**, then swept.
  Their history remains in the database; their screenshots do not.
- **`remote_computer` is a permission with no backend behind it yet.** It is in
  the vocabulary because the policy engine needs to be able to deny it, not
  because a remote surface exists.
