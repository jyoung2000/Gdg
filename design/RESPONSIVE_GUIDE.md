# Responsive behaviour

Meridian has three layout modes. They are **re-compositions, not resizes**: a
200px column of file names is useless on a phone, so it becomes a drawer rather
than a narrower column.

---

## Breakpoints

| Token | Value | Mode |
| --- | --- | --- |
| `--breakpoint-sm` | `640px` | Below: single pane |
| `--breakpoint-md` | `900px` | Below: sidebar and drawer become overlays |
| `--breakpoint-lg` | `1200px` | Below: the assistant becomes an overlay |
| `--breakpoint-xl` | `1600px` | Comfortable three-panel workstation |

The JavaScript side uses the same values through `useMediaQuery` and the
`BREAKPOINT` constants in `apps/web/src/lib/media.ts`. The mode change is a
different component tree, not different CSS, so it has to be visible to React.

---

## Desktop, above 1200px

The full three-panel workstation.

```
┌────────────────────────────────────────────────────────────┐
│ Toolbar                                        44px        │
├───────────┬──────────────────────────────┬─────────────────┤
│ Sidebar   │ Main workspace               │ Assistant       │
│ 216px     │ flexible                     │ 340px           │
│           ├──────────────────────────────┤                 │
│           │ Drawer  260px (toggled)      │                 │
├───────────┴──────────────────────────────┴─────────────────┤
│ Status bar                                     26px        │
└────────────────────────────────────────────────────────────┘
```

- Sidebar collapses to `--sidebar-width-collapsed` (52px) on request; the
  preference persists.
- Columns are resizable via `SplitPane`; sizes persist per device.
- The assistant is a real column.

## Tablet, 900px – 1200px

Two panels. The assistant becomes an **overlay sheet** anchored to the right,
opened from the toolbar, dismissed by the scrim or `Esc`. The sidebar stays a
column. The drawer still docks at the bottom.

## Narrow, 640px – 900px

- The **sidebar** becomes a fixed drawer that slides in from the left, opened
  by the toolbar's menu button, over a scrim.
- The **panel toggles** for the terminal drawer are removed: there is no room
  for a docked drawer, so a toggle for it would toggle nothing.
- The assistant toggle **stays**, because the assistant is the product.
- Screen padding drops from `--space-6` to `--space-4`.

## Mobile, below 640px

Single pane.

- Card grids collapse to one column.
- The workspace name and the brand wordmark leave the toolbar; the mark stays.
- The Search button loses its label and becomes an icon — the palette is still
  one tap away.
- Toasts span the full width, inset by `--space-3`.
- The assistant overlay is full-viewport width.
- The status bar drops its inventory and paid-routing text, keeping the
  connection chip and the port.
- Screen headers wrap, so a title and its action stack instead of competing
  for one line.

---

## Dense surfaces

The shell **never scrolls horizontally**. Content that cannot fit scrolls
inside its own container.

| Surface | Behaviour |
| --- | --- |
| Tables | Wrapped in `overflow-x: auto` with a sticky header; the page does not move |
| Diff viewer | Split mode becomes stacked below 900px; each side scrolls itself |
| Code blocks | `overflow-x: auto` inside the block |
| Terminal | xterm's own viewport, refitted by a `ResizeObserver` |
| Model list | Card grid reflows; the table view scrolls horizontally |
| Settings | The category list becomes a horizontal scroller above the detail pane |
| Generations | Parameters move above the canvas |
| Workspace | File tree and editor stack; the diff list moves above the diff |

Every flex child that holds text carries `min-width: 0` so it can truncate
rather than force its parent wider — the single most common cause of an
unexpected horizontal scrollbar.

---

## Pointer and touch

- Controls are at least `--control-height` (28px), with resizer handles
  extending their hit area 4px either side of the visible 1px line.
- Drag interactions use pointer events with `setPointerCapture`, so mouse,
  touch and pen all work from one code path.
- No interaction requires hover. Every tooltip's content is also the control's
  accessible name.

---

## Orientation

There is no orientation-specific layout. A phone in landscape is simply a
wider viewport and picks up whichever mode its width selects, which is the
correct answer for a layout driven by available width rather than device class.

---

## Testing checklist

Check at these exact widths. These are the widths the implementation was
verified at with a headless browser, asserting that
`document.documentElement.scrollWidth <= window.innerWidth`:

| Width | What to confirm |
| --- | --- |
| **1600px** | Three panels, no overflow, comfortable density |
| **1280px** | Assistant still a column, sidebar resizable |
| **1100px** | Assistant has become an overlay |
| **900px** | Sidebar is a drawer, terminal toggle gone |
| **768px** | Card grids still two-up, tables scroll themselves |
| **640px** | Single column, toolbar reduced |
| **390px** | No horizontal scroll anywhere, every control reachable |

Also confirm at each width: light and dark, `prefers-reduced-motion`, and
200% browser zoom.
