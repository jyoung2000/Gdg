# The interface: what moved, and where everything went

Meridian gained twenty-two permanent sidebar destinations one capability at a
time, each one reasonable on its own. Together they made the first screen a
directory of the product's own subsystems — a filing cabinet rather than
somewhere to ask for something.

This is what changed, what did not, and where to find anything that moved.

**Nothing was removed.** Not a screen, not a route, not a control, not a
setting. The whole of the change is *what is visible by default*.

---

## The navigation

**Before:** 22 permanent destinations across two sections.
**After:** 5 destinations, a New chat action, and one disclosure.

```
MERIDIAN
  + New chat
  Chats            ← the default landing screen
  Projects
  Models
  Activity
  Settings

MORE
  ▸ Everything else   ← Home, Workspace, Director, Tasks, Agents, Browser,
                        Computer, Version Control, Generations, Discover, AI,
                        Skills, Connections, Pools, MCP, DevOps
```

Measured on the running application: **7 sidebar items visible by default, 23
after opening More.** Nothing lost, sixteen fewer competing for attention.

The disclosure opens by itself when the current screen lives inside it, so the
navigation never hides where you are. `tests/ui/screens.test.ts` clicks through
the real sidebar to every one of the 21 screens — opening the disclosure the way
a person would — which is what proves nothing was orphaned rather than asserting
it.

## Chat is the landing screen

It was Home, which listed workspaces and subsystem status. It is now Chat,
which asks what you need.

"New chat" genuinely starts a new conversation: the conversation lives in the
chat screen's own state, so the action bumps a counter the shell keys the screen
on, and the screen remounts empty. A button labelled *New chat* that navigated
to a screen still holding the last exchange would be a lie told every time
someone pressed it.

## The inspector is contextual, not permanent

The right-hand panel used to be open by default at every width, spending a third
of the screen on metadata about a request that had not been made yet. It is the
single biggest reason the first screen read as an operations console.

It now opens on demand — the toolbar toggle, the command palette, or any control
that has something to explain. It keeps its state, and everything it showed it
still shows. Verified: `permanentInspector=0` at 390, 834, 1200 and 1440 px.

## Models is where the AI lives

Models, Connections, Discover and Pools were four unrelated destinations
answering one question: *what AI can Meridian use?* Models is now the way in to
all four.

They are links rather than embedded tabs, deliberately. Connections, Discover
and Pools are substantial screens with their own state, their own deep links and
their own tests; re-parenting them into one component would have meant rewriting
three working screens to change where they are reached from. The navigation
changed; the screens did not.

---

## Where everything went

| Capability | Where it is now |
| --- | --- |
| Chat | **Chats** — the default screen |
| Home / dashboard | More → Home |
| Workspace | More → Workspace |
| Projects | **Projects** |
| Director | More → Director |
| Tasks | More → Tasks |
| Agents | More → Agents |
| Browser tools | More → Browser |
| Computer agent | More → Computer |
| Version control | More → Version Control |
| Generations | More → Generations |
| Model catalogue | **Models** |
| Providers / credentials | **Models → Connections**, or More → Connections |
| Free-model discovery | **Models → Discover free models**, or More → Discover |
| Pools and reservations | **Models → Pools**, or More → Pools |
| AI control plane | More → AI |
| Skills | More → Skills |
| MCP servers | More → MCP |
| DevOps / Docker | More → DevOps |
| Usage and analytics | **Activity** |
| Settings | **Settings** |
| Everything, by name | Command palette (⌘K / Ctrl-K) |

Every row was checked by clicking through the real navigation in a browser.

---

## What was deliberately not done

This pass changed **where things are**, not what they are. It did not:

- rewrite any screen's internals, or its state, or its API calls
- change any routing semantics — `FREE` is still strict, `FREE_FIRST` is still
  capacity-aware, and the UI cannot bypass either because it does not implement
  either
- remove a single setting, control, filter or view
- replace the design system, or add a second one

The routing picker exposes the six everyday modes and an **Advanced** control
for the explicit policies. That is a presentation of the same modes the router
already had — `canonicalMode()` maps them, and the guarantees live in the
router, where the UI cannot weaken them.

## The offline edition

`offline-ui/index.html` is the same interface, self-contained, opened straight
from disk. It inlines the **production stylesheet** and uses the same class
names, so it cannot drift into being a separate design — regenerate it with
`pnpm build:offline-ui` after any UI change.

See [offline-ui/README.md](../offline-ui/README.md).
