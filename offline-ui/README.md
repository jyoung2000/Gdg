# Meridian — offline preview

Open `index.html`. That is the whole of it.

```
open offline-ui/index.html          # macOS
xdg-open offline-ui/index.html      # Linux
start offline-ui\index.html         # Windows
```

No installation. No Node, no npm, no Docker, no database, no API key, no
server, no internet. One file, opened straight from disk with `file://`.

---

## What this is

The Meridian interface, rendered offline so you can look at it and click
through it before deciding whether to install anything.

It is **the real stylesheet** — this file inlines the production CSS from
`dist/web/assets/`, and the markup uses the same class names — so what you see
here is what the application looks like, not an artist's impression of it.
`scripts/build-offline-ui.mjs` regenerates it from the current build, which is
what stops the two from drifting apart.

## What is real and what is not

**Real:** the layout, the typography, the spacing, the navigation, the
disclosure, the drawers, the pickers, the filters, the search, the command
palette (⌘K / Ctrl-K), the mobile sheet, keyboard dismissal, and the responsive
behaviour at every width.

**Simulated:** the backend. Nothing is sent anywhere, no model runs, no
provider is contacted, and no request leaves your machine — there is nothing
here that could make one.

**The data is a demonstration.** The models, providers, conversations,
activity and figures are fixed local examples, chosen to exercise the layout
honestly. They are not live provider data and are not a claim about what any
provider currently offers. The header says `OFFLINE PREVIEW` for that reason.

## What you can do

- Ask something in the composer and watch a request become a task with stages
- Open **Why this model?** to see the routing explanation — what was chosen,
  and what was rejected and for which reason
- Browse **Models**, search and filter them, open one for its details
- Open **Connections** to see provider accounts, health and data-use terms
- Open **Discover** to see the free-inference sources and what they found
- Toggle **Tools**, change the routing mode, walk through **Settings**
- Press ⌘K (Ctrl-K) for the command palette
- Resize to a phone width and use the navigation sheet

Everything the production sidebar reaches is present, so nothing here is a dead
link. The advanced destinations are represented by name rather than fully
simulated; the surfaces a first-time user actually meets are rendered in full.

## One thing worth noticing

Meridian never labels an unknown cost as free. In the Models screen, filter to
**Free** and note that a model whose pricing is not established disappears
rather than being counted — the same rule the real routing engine applies. It
is the behaviour the whole free-inference subsystem exists to guarantee, and it
is visible here.
