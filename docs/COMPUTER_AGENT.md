# The computer agent

Meridian can let a model see this machine's screen and operate it — move the
pointer, click, type, open applications. This document describes what that
actually does, what it refuses to do, and how each guarantee was verified.

**It is off unless you start a session.** There is no setting that leaves it
armed, no background process holding the display, and no default that hands a
model control. Starting a session is the only thing that turns it on, and
stopping one is the only thing needed to turn it off.

---

## The shape of it

Four pieces, deliberately separate:

| Piece | What it is | Where |
| --- | --- | --- |
| **Action protocol** | The vocabulary every model speaks and every backend understands | `packages/computer-sdk/src/types.ts` |
| **Policy engine** | Validate → permission → risk → approval, before anything reaches the machine | `packages/computer-sdk/src/policy.ts` |
| **Backends** | The surfaces that can be driven | `packages/computer-sdk/src/backends/` |
| **Loop** | Observe, plan, act, repeat — knowing nothing about which model or backend | `packages/computer-sdk/src/loop.ts` |

The model and the backend never meet. The only place they touch is the planner
in `apps/gateway/src/services/computer.ts`, which turns a screenshot into an
ordinary Meridian model call and turns the reply back into a normalized action.
That is the whole coupling, which is what makes any vision-capable model able to
drive any available backend — there is nowhere for a model-to-agent mapping to
hide, because there is no table to put one in.

### Actions

`screenshot`, `move`, `click`, `double_click`, `right_click`, `drag`, `type`,
`key_press`, `hotkey`, `scroll`, `wait`, `open_application`,
`close_application`, `finish`.

A backend advertises which of these it can perform; anything else is refused
before it is attempted, so a plan can never propose a step that could only fail.

### Grounding

Computer-use models are trained to point in a normalized space — 1000×1000 is
common — not in your screen's pixels. Meridian asks the model to emit in that
space and scales what comes back:

```
MERIDIAN_GROUNDING_WIDTH=1000
MERIDIAN_GROUNDING_HEIGHT=1000
```

Unset, the model is asked to point in real pixels. Both must be set together;
half a grounding space would scale one axis and not the other, putting every
click off by a factor, so a partial setting is ignored rather than half-applied.

`toScreenPoint()` does the conversion and clamps to the screen. The E2E test
derives its expected pixel from the geometry the backend reports rather than
hard-coding one, so it asserts the scaling contract itself.

---

## Backends

| Backend | Surface | Requires |
| --- | --- | --- |
| `native` | This machine's desktop, via X11 | An X display and a Python with `pillow` + `python-xlib` |
| `browser` | A browser page as the screen | Chromium, through Meridian's browser SDK |
| `agent-s` | Agent-S, if installed | `agent_s` on PATH |
| `ui-tars` | UI-TARS, if installed | `ui-tars` on PATH |

Every backend is always listed. One that cannot run appears as unavailable with
the reason and what would fix it — never absent, because a backend that vanishes
gives the user no way to find out why.

**`agent-s` and `ui-tars` are detected, not implemented.** Their health checks
run the real binary and report honestly whether it is installed, but opening a
session on them throws: the adapter that would translate Meridian's action
protocol into their agent loops is not written. They are listed because
detection is real and the remediation is accurate, not because they work. See
*Known limitations*.

### The native backend

Input goes through the X11 XTest extension and capture through Pillow — the same
layer `pyautogui` uses, and therefore the same layer Agent-S drives. The work
happens in a small helper process (`packages/computer-sdk/helper/xagent.py`)
rather than inline, for two reasons: the mature X bindings are in Python, and
one short auditable file with no shell, no `eval` and no network is easier to
reason about than the same operations scattered through the gateway.

`open_application` re-validates the application name against
`/^[A-Za-z0-9 ._+-]{1,64}$/`, resolves it with `shutil.which`, and launches it
with an argv list — never a shell string. A name containing a shell
metacharacter is refused at the policy layer and refused again in the helper.

The helper runs only while a session holds it open. Probing backend health
starts one, reads the screen geometry, and shuts it down again, so an idle
gateway has no process able to synthesise keystrokes.

There is one desktop, so there is one desktop session: starting a second
native session while one is live is refused, naming the session that holds it.
A browser session gets its own page, so several can run at once.

### Running headless

Meridian is most often run on a machine with no monitor, which is exactly where
"drive the desktop" is least meaningful. Two honest options:

- **Use the browser backend.** A page is a real screen with real pointer and
  keyboard events at real coordinates. This is the useful default on a server.
- **Give the container a display.** `Xvfb :99 -screen 0 1280x800x24` and
  `DISPLAY=:99` gives the native backend a genuine X server to drive. Whatever
  runs on that display is what the agent sees.

A container **cannot** drive the host's desktop, and Meridian does not pretend
otherwise: with no reachable display the native backend reports unavailable and
says so. Doing it anyway would need a deliberate transport — an agent process on
the host that the gateway talks to — which is not built. No amount of privileged
Docker flags substitutes for that, and none are required to run any of this.

---

## Permissions

Sixteen, granted individually, defaulting to none:

```
screen  mouse  keyboard  clipboard  open_application  browser  terminal
files_read  files_write  files_delete  files_download  files_upload
mcp  docker  network  remote_computer
```

File access is split four ways because reading, writing, deleting and
transferring are not the same risk and should not be one checkbox.

Two presets, served from the gateway so the UI cannot show a grant the backend
would not apply:

- **`readOnly`** — `screen`. Look, nothing else.
- **`safe`** — `screen`, `mouse`, `keyboard`, `open_application`. Ordinary
  interactive use. What makes it safe is the line it does not cross: nothing
  reaching the filesystem, a shell, the network, or another machine.

**The backend enforces these, not the model.** The model is told its permissions
so it plans sensibly, and told plainly that Meridian enforces them regardless.
An action requiring a permission that was not granted is rejected in
`policy.ts` before it reaches any backend — the model's cooperation is a
convenience, never the mechanism.

Unrecognised permission names in a request are dropped rather than stored, so a
typo can never look like a grant.

## Risk and approval

Every action is classified `safe`, `elevated`, or `destructive` from what it
would actually do — text about `rm -rf`, `mkfs`, `dd if=`, `DROP TABLE` or
`shutdown` is destructive; `sudo`, piping a download into a shell, `git push`,
anything that looks like a credential, and anything that spends money is
elevated.

Three approval modes:

| Mode | Behaviour |
| --- | --- |
| `every_action` | Nothing runs without a yes |
| `risky_actions` | Routine steps run; elevated and destructive wait (**default**) |
| `autonomous` | Routine and elevated run; **destructive still asks** |

Destructive actions ask in every mode. "Allow for this task" never applies to
them — approving one deletion is not a standing licence to delete.

An approval that nobody answers within five minutes is **denied**, not left
pending: a dialog holding a session open forever is its own failure mode.

The dialog names the action concretely — "Move the pointer to 777, 555", not
"the agent wants to continue". A person cannot consent to something unnamed.

## Stopping

Stop is the guarantee everything else rests on, so it is worth being precise
about what it does.

`session.stop()` aborts the operation actually in flight, releases anything
waiting on a pause or an approval, and moves the session to a terminal state the
loop re-checks before every step. Every long call a session makes — capturing
the screen, **asking the model for the next step**, executing an action — runs
through `session.runOp()`, which registers its `AbortController` as the
session's current operation.

That last point is the whole of it. An earlier version registered only the
action execution, so a Stop pressed while the model was thinking flipped the
session to `stopped` while the request stayed in flight and the helper process
stayed alive. That was found by pressing Stop against a model that never
answered and watching the process list; see *Verification* below.

A `wait` is interruptible for the same reason: a 45-second sleep during which
the kill switch does nothing makes Stop feel broken exactly when someone is
reaching for it.

Stop is the one action with no ownership check, unlike pause, resume and
approve. Anyone who can see that a machine is being driven must be able to make
it stop without first proving whose session it is or finding an administrator.
Being able to halt someone else's agent is a far smaller risk than being unable
to halt your own.

## Routing

Auto picks by capability, then explains itself:

- **Vision is required.** A model that does not report vision cannot drive a
  computer and is refused by name, with the reason.
- Confirmed vision outranks declared vision, which outranks vision inferred
  from a model's name — and the explanation says which it was.
- `local_only` filters to local models and reports an error if there are none.
  It never quietly falls back to a hosted model: a screenshot of your desktop is
  not something to send somewhere you did not choose.
- A dedicated grounding model is used when one is available; otherwise the
  primary model grounds, and the explanation says so.

Auto never simply takes the first model. The decision comes back with its
factors — every one a sentence, not a score.

Fallback retries **planning** only. An action that already reached the machine
is never replayed because the next model call failed: repeating a half-finished
destructive step is precisely the behaviour that must not happen.

---

## Using it

**In the UI.** The Computer screen. The running state is the loudest thing on
the page; the permissions a session was granted are shown beside what it is
doing; Stop is reachable whenever a session is alive.

**From the chat composer.** An Agent Mode selector offers *Normal AI* (the
default, on every visit — deliberately not remembered) and *Computer agent*.
Choosing the latter and pressing Enter does not hand over control: it opens a
confirmation naming exactly what the session will and will not be allowed to
do. Pressing Enter is a reflex; handing over the pointer should not be.

**Over HTTP.**

```
GET  /api/computer/backends            what can run, and why the rest cannot
GET  /api/computer/vocabulary          permissions, approval modes, presets
POST /api/computer/plan                what Auto would choose, without starting
POST /api/computer/diagnostics         six checks against the live backend
POST /api/computer/sessions            start one (admin)
GET  /api/computer/sessions/:id        state and every action, refusals included
POST /api/computer/sessions/:id/stop   stop (any authenticated caller)
POST /api/computer/sessions/:id/pause  | /resume | /approve | /deny
```

Starting a session is administrative — it hands a model a pointer and a keyboard
on a real machine. Reading and stopping are not.

Sessions are owned by whoever started them. Another user reading, pausing or
approving one gets "no such session" rather than a permission error, so session
ids cannot be probed for.

## What is recorded

Every session and every action, in `computer_sessions` and `computer_actions`
(migration `007_computer_agent.sql`) — including the actions that were **denied**
and the ones that were never run. The record of what an agent was refused
matters as much as the record of what it did.

A session's row snapshots the configuration it ran under, so a completed run
stays auditable after the instance defaults change. Ownership, the task and that
snapshot are written once and never updated.

---

## Verification

Everything below was run against a live gateway with a real X display
(`Xvfb :99`, 1280×800), a real Python helper, and a real local inference server.
Nothing here is asserted from reading the code.

**Backends.** `native` reported `available=true X11 1280x800 on :99`; `browser`
reported `available=true chromium engine`; `agent-s` and `ui-tars` reported
`available=false` with install instructions.

**Diagnostics.** Six checks pass: permission engine, action validation, backend
health, screen geometry, screen capture, pointer control. The pointer check only
moves — it never clicks or types, because a diagnostic must not be able to
activate anything.

**Real pointer control.** A session drove the pointer to 222,333 and then to
640,320; both were confirmed by querying the X server directly with
`XQueryPointer`, not by trusting the session's own report. The second confirms
scaling: the model emitted 500,400 in a 1000×1000 grounding space and the
pointer landed on 640,320 on a 1280×800 screen.

**Auto routing.** Chose `meridian-sim-vision` — not the first model in the list
— with factors including "vision is inferred from the model name, not
confirmed", "supports tool calling", "free to run", and "no dedicated grounding
model is available, so the primary model grounds".

**Refusing a non-vision model.** Pinning `meridian-sim-chat` was refused: "it
does not report vision".

**Permission enforcement.** A session granted `screen` only proposed a `type`
action. Result: `status: denied`, `verdict: reject`, reason `This session does
not have the "keyboard" permission`. The keystroke never reached the machine.

**Approval gating.** A session in `every_action` mode proposed a pointer move.
The session entered `awaiting_approval` with the description "Move the pointer
to 777, 555". **The pointer was still at 10,10 while the approval was pending**,
confirmed against the X server — proving the action had not run. Denying
returned `{"denied": true}`, the pointer was still at 10,10 afterwards, and the
action recorded `status: denied, error: "denied by the user"`.

**Stop, against a model that never answers.** With the inference server told to
accept the request and never reply, the session parked inside the model call.

- *Before the fix:* Stop returned `stopped` — and the helper process was still
  alive twelve seconds later, still holding an X connection with synthetic input
  capability. The kill switch could not reach the request the loop was blocked
  on. This is the defect that motivated `runOp`.
- *After the fix:* Stop took effect in under a second and the helper process was
  gone, verified by process listing. The session recorded `summary: "stopped by
  the user"` with no error, and no further steps were taken.

**Stop, during a 45-second wait.** Stop returned in 10ms, the helper was
released, and the action recorded "the action was cancelled or timed out" rather
than running to completion.

**A killed gateway leaves no orphan.** A process opened the native backend and
was then `SIGKILL`ed with no chance to clean up — the worst case, since no
shutdown code runs. The helper was gone within three seconds, because
`PR_SET_PDEATHSIG` asks the kernel to signal it when its parent dies. Verified
by process listing before and after.

**A health probe leaves nothing running.** Probing the native backend's health
spawns a helper, reads the screen geometry and shuts it down again; the process
count before and after a probe is identical. An earlier version left one running
for the life of the gateway, and so did every diagnostics run.

**A full test run leaves nothing behind.** After the E2E suite completes the
process exits with code 0 and no helper processes remain. That is checked by
observation rather than forced with `--test-force-exit`: the runner hanging
after every test had passed was the symptom that exposed three separate leaks —
diagnostics never releasing the backend, the gateway never closing its browser,
and helper shutdown killing only the currently-tracked child when a probe and a
session open had interleaved.

**Repetition.** A model proposing the same move three times in a row stopped the
session at step 2 of 8 with "Stopped after proposing the same move action 3
times in a row without making progress" — rather than burning the step budget
and reporting an unhelpful step-limit failure.

**Persistence.** A finished session's stored row carries its state, summary, end
time, owner and config snapshot; its actions are stored with their verdicts.

The automated form of all of this is `tests/e2e/computer-agent.test.ts`, which
runs against a real gateway and a real inference server. The cases that drive a
physical pointer skip themselves without an X display rather than reporting a
pass they did not earn.

---

## Known limitations

Stated plainly, because a limitation described as a feature is worse than one
that is missing.

- **Agent-S and UI-TARS are detected, not driven.** Health checks are real and
  the remediation text is accurate. `open()` throws with an honest message. The
  adapter between Meridian's action protocol and their agent loops is not
  written.
- **One display.** X reports a multi-head setup as one large screen, and that is
  what the agent sees. `ScreenContext.singleDisplayOnly` is `true` and the UI
  says so. There is no display picker, and none is implied.
- **A container cannot drive the host desktop.** With no reachable display the
  native backend reports unavailable with the reason. The host-agent transport
  that would make it possible is not built.
- **The browser backend cannot launch applications.** A page has no notion of
  starting a program, so `open_application` is not in its supported actions and
  a plan proposing it is refused rather than attempted.
- **No horizontal scrolling on the browser surface.**
- **The native backend cannot close applications.** There is no safe general
  mechanism; a window-manager hotkey is the honest alternative and the error
  says so.
- **Sessions are held in memory for fifteen minutes after finishing**, then
  swept. Their full history remains in the database and the API falls back to
  it, but the screenshots are not retained.

## Upstream work this draws on

Meridian implements its own action protocol, policy engine and backends. No
upstream application is vendored or copied. What is borrowed is design:

- **[Agent-S](https://github.com/simular-ai/Agent-S)** — the separation of
  planning from grounding, and the `--grounding_width` / `--grounding_height`
  convention that `ScreenContext` follows. Its input layer (`pyautogui` over
  XTest) is the same one `xagent.py` drives.
- **[UI-TARS Desktop](https://github.com/bytedance/UI-TARS-desktop)** — the
  operator abstraction, and specifically treating a browser and a desktop as
  peer surfaces rather than one being a lesser substitute for the other. Its
  `scaleX`/`scaleY` handling is the same coordinate problem `toScreenPoint`
  solves.

Both are cited in the source files that borrow from them.
