# Meridian — UI Specification

Screen-by-screen specification for the Meridian workstation.

Meridian is a self-hosted Universal AI Gateway. Its client is a workstation, not a website: a
full-height shell that owns its own scrolling, keeps its chrome still, and puts dense
information in front of an operator who will spend hours in it. The design language is
original, informed by desktop-software principles — clarity, hierarchy, restraint, precision,
direct manipulation, calm surfaces. Nothing here is derived from or endorsed by any vendor's
design system.

---

## 1. How to read this document

### 1.1 What exists, and what this document specifies

The design system in `packages/ui/src` exists and is the authority on visual and interaction
detail. This document does not restate it; it specifies **which regions each screen has, what
they compose from, and how they behave when they are empty, loading, broken, resized or driven
from the keyboard**.

Available today, and the only building blocks a screen may use:

| Module | Exports |
| --- | --- |
| `tokens/tokens.css`, `tokens/base.css` | every colour, size, radius, shadow, duration; reset and `mrd-*` utilities |
| `tokens/tokens.ts` | typed mirror: `space`, `radius`, `color`, `shadow`, `duration`, `easing`, `zIndex`, `breakpoint`, `elevation` |
| `primitives/Button` | `Button`, `IconButton`, `ButtonGroup` |
| `primitives/Form` | `Input`, `TextArea`, `SearchField`, `Select`, `Checkbox`, `Radio`, `RadioGroup`, `Switch`, `Slider`, `Field`, `FormRow`, `DisclosureRow`, `Fieldset` |
| `primitives/Controls` | `SegmentedControl`, `Tabs`, `TabList`, `Tab`, `TabPanel`, `Kbd`, `Badge`, `StatusChip`, `Progress`, `Meter`, `Avatar`, `Skeleton`, `Stars` |
| `primitives/Overlay` | `Popover`, `Menu`, `MenuItem`, `MenuGroup`, `MenuSeparator`, `Tooltip`, `Dialog`, `Sheet`, `Toast`, `ToastProvider`, `useToast`, `ContextMenu` |
| `primitives/util` | `cx`, `isApplePlatform`, `formatShortcut`, `matchesShortcut` |
| `layouts/Layout` | `Panel`, `PanelHeader`, `PanelBody`, `Card`, `Toolbar`, `ToolbarGroup`, `ToolbarSeparator`, `Sidebar`, `SidebarSection`, `SidebarItem`, `SplitPane`, `StatusBar`, `EmptyState`, `Inspector`, `Stack` |
| `components/Data` | `List`, `ListRow`, `Table`, `Timeline`, `TimelineStep`, `KeyValue` |

`packages/ui/src/icons`, `packages/ui/src/patterns` and `packages/ui/src/themes` are empty
directories. There is no icon set, no chart component, no code editor, no file tree, no diff
viewer, no terminal and no command palette in the package. Every one of those is **screen-local
code composed from the list above**, and this document says how each is composed. Where a screen
needs a glyph, it passes one as a `ReactNode` to the `icon` prop of an existing component; the
component sizes it (Button 15px, `size="sm"` 13px; IconButton 16px, sm 13px, lg 18px;
SidebarItem 16px; EmptyState 20px, `size="sm"` 16px).

`packages/ui/package.json` declares `"main": "./src/index.ts"`, but that barrel is not written
yet. Examples below import from `@meridian/ui` because that is the intended public entry point;
until the barrel exists, import from the source module (`../primitives/Button.js`).

### 1.2 Conventions

- **Must** is a requirement. **Should** is a default that a screen may override with a reason.
- Every dimension quoted is a token, with its real value in brackets: `--space-4` (16px).
- Diagrams are proportional sketches, not pixel maps. The numbers beside them are the real ones.
- "The primitive already does this" marks behaviour a screen inherits and must not reimplement.

### 1.3 Behaviour the primitives already provide

A screen must not rebuild any of the following. Getting these wrong a second time, differently,
in each screen, is how a workstation stops feeling like one program.

| Behaviour | Provided by |
| --- | --- |
| Escape closes only the topmost dismissible layer | overlay layer stack in `Overlay.tsx` |
| Focus trap, focus restore, body scroll lock, scrim | `Dialog`, `Sheet` (shared modal shell) |
| Menus: roving focus, type-ahead, Home/End, submenu chevron, shortcut column | `Menu`, `MenuItem` |
| Popover flip-and-clamp positioning, portalled out of clipping ancestors | `Popover` |
| Single tab stop with arrow-key movement inside a list or a selectable table | `List`, `Table` |
| Roving tabindex and arrow keys across tabs and segments | `TabList`, `SegmentedControl` |
| Pointer, arrow, Home and End resizing of panes, with per-pane floors | `SplitPane` |
| Escape clears a search field before it reaches the surrounding dialog | `SearchField` |
| Toast queueing, capped stack, pause-on-hover-or-focus, live region | `ToastProvider`, `Toast` |
| Copy-to-clipboard with an announced confirmation | `KeyValue` (`copy` on an item) |
| Right-click **and** the context-menu key / Shift+F10 | `ContextMenu` |
| Reduced motion, high contrast, dark theme | `tokens.css` media and attribute blocks |

---

## 2. The density budget

Density is not a feeling. It is a set of fixed numbers from `tokens.css`, and a screen that
invents a height outside them is a bug.

### 2.1 Layout tokens

| Token | Value | Governs |
| --- | --- | --- |
| `--toolbar-height` | 44px | the shell toolbar; also the `min-height` of every `PanelHeader` and `Panel` footer |
| `--statusbar-height` | 26px | the shell status bar |
| `--sidebar-width` | 216px | the expanded navigation column |
| `--sidebar-width-collapsed` | 52px | the icon-only navigation column |
| `--inspector-width` | 340px | the right-hand properties column; also the unit dialogs, sheets, popovers and toasts are sized from |
| `--drawer-height` | 260px | the bottom drawer's resting height |
| `--control-height-sm` | 22px | dense inline controls |
| `--control-height` | 28px | the default control height (Button, Input, Select, MenuItem, table header) |
| `--control-height-lg` | 34px | sidebar items, tabs, table body rows, the segmented track |
| `--row-height` | 26px | `List` rows at the default size |

### 2.2 Derived geometry

These follow from the tokens and are quoted here so a screen never has to guess.

| Surface | Height / width |
| --- | --- |
| `Panel` header, `Panel` footer, `Sidebar` header | min 44px (`--toolbar-height`), padding `--space-2` `--space-4` (8px / 16px) |
| `PanelBody` when `padded` | 16px (`--space-4`) on all sides |
| `Sidebar` body | 8px (`--space-2`) padding, 20px (`--space-5`) between sections |
| `SidebarItem` | 34px, 8px gap, radius `--radius-md` (8px) |
| `List` row | 26px default, 22px at `size="sm"`, 34px at `size="lg"` |
| `Table` header cell | 28px, uppercase panel type |
| `Table` body cell | 34px, hairline separators, never zebra striping |
| `MenuItem` | 28px, radius `--radius-lg` (10px) |
| `Tab` (underline) | 34px; `Tab` (pill) 28px |
| `SegmentedControl` track | 34px at `size="md"`, 28px at `size="sm"` |
| `Dialog` max width | sm 340px, md 500px (`340 + 2 × 80`), lg 680px (`340 × 2`) |
| `Sheet` `side="right"` | 388px (`340 + 48`), capped at 100% |
| `Sheet` `side="bottom"` | full width, max 85% of the viewport height |
| `Popover` | max width `min(340px, 100vw − 32px)`, max height `100vh − 40px` |
| `Tooltip` | max width 260px (`340 − 80`) |
| Toast column | `min(340px, 100vw − 32px)`, 20px from the bottom-right corner |

### 2.3 The three-panel arithmetic

At the `lg` breakpoint (1200px) the fixed chrome is 216px of sidebar plus 340px of inspector
plus two 1px resizers: 558px. The centre column gets 642px. That is the floor at which all three
panels are worth showing, and it is why the inspector leaves the flow below 1200px (§3.7).

---

## 3. The app shell

### 3.1 Purpose

One window, one program. The shell holds every screen; screens replace only the contents of the
main column and the inspector. Navigating between screens must never move the toolbar, the
sidebar, the status bar or the scroll position of anything outside the main column.

### 3.2 Layout

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Toolbar                                                        44px       │
│  [left group]              [grow / centre]              [end group]        │
├──────────┬───────────────────────────────────────────────┬─────────────────┤
│          │                                               │                 │
│ Sidebar  │  Main                                         │  Inspector      │
│ 216px    ║  flexes                                       ║  340px          │
│ (52px    ║                                               ║                 │
│ collapsed│                                               │                 │
│          │                                               │                 │
│          ╞═══════════════════════════════════════════════╡                 │
│          │  Drawer                             260px     │                 │
├──────────┴───────────────────────────────────────────────┴─────────────────┤
│  Status bar                                                     26px       │
└────────────────────────────────────────────────────────────────────────────┘
   ║ = SplitPane resizer (1px line, 9px hit area)
   ╞ = horizontal resizer between main content and drawer
```

The shell is a flex column: `Toolbar`, then a flex row that fills the remaining height, then
`StatusBar`. The row is a horizontal `SplitPane` when the inspector is present, so the user can
trade centre width against inspector width; the sidebar sits **outside** the `SplitPane` because
its width is a token, not a fraction — it is either 216px or 52px and nothing between.

```tsx
import {
  Toolbar, ToolbarGroup, ToolbarSeparator,
  Sidebar, SidebarSection, SidebarItem,
  SplitPane, Inspector, StatusBar, Stack,
} from '@meridian/ui';

export function Shell({ screen, collapsed, sizes, onSizesChange }: ShellProps) {
  return (
    <div className="mrd-vstack" style={{ height: '100%' }}>
      <Toolbar label="Window controls">
        <ToolbarGroup>{/* sidebar toggle, workspace menu */}</ToolbarGroup>
        <ToolbarSeparator />
        <ToolbarGroup grow align="center">{/* screen title or omnibox */}</ToolbarGroup>
        <ToolbarGroup align="end" label="Session">{/* mode, status, overflow */}</ToolbarGroup>
      </Toolbar>

      <Stack direction="row" align="stretch" style={{ flex: '1 1 auto', minHeight: 0 }}>
        <Sidebar collapsed={collapsed} label="Primary" header={<WorkspacePicker />}>
          <SidebarSection title="Work">
            <SidebarItem icon={<HomeGlyph />} label="Home" active />
            <SidebarItem icon={<TaskGlyph />} label="Tasks" badge={3} />
          </SidebarSection>
        </Sidebar>

        <SplitPane
          direction="horizontal"
          sizes={sizes}
          minSizes={[0.35, 0.2]}
          onSizesChange={onSizesChange}
          separatorLabel={() => 'Resize inspector'}
        >
          {screen.main}
          <Inspector title={screen.inspectorTitle}>{screen.inspector}</Inspector>
        </SplitPane>
      </Stack>

      <StatusBar left={<Connection />} center={<ActiveRoute />} right={<Spend />} />
    </div>
  );
}
```

### 3.3 The toolbar, and what may live in it

`Toolbar` is 44px, one row, and never wraps or scrolls. `Layout.css` gives every child
`min-width: 0` so a long label shrinks rather than pushing its neighbours off the edge. It is
deliberately **not** `role="toolbar"`: that role promises roving-tabindex arrow navigation, and
a bar holding menus, search fields and segmented controls cannot honour it. Each control keeps
its own tab stop.

Rules, in force everywhere:

1. **Scope.** Only controls that act on the whole window or on the current screen as a whole. A
   control that acts on a selection belongs in the inspector; a control that acts on one row
   belongs in that row or its context menu.
2. **Three groups, in order.** A leading `ToolbarGroup` for window and navigation identity
   (sidebar toggle, workspace switcher, back/forward). One `ToolbarGroup grow align="center"`
   for the screen's identity — its title, or the omnibox on screens that have one. A trailing
   `ToolbarGroup align="end" label="…"` for session state: routing mode, connection, overflow.
3. **Control sizes.** `IconButton` at the default `size="md"` (28×28) and `Button size="md"`
   (28px). `size="lg"` (34px) is for the composer and for empty-state calls to action, not for
   the toolbar. `size="sm"` (22px) is for sub-bars inside a panel, not for the shell.
4. **Budget.** At most nine interactive elements across all three groups. Anything beyond that
   goes into a `Menu` behind one `IconButton`.
5. **Labels.** A `Button` in the toolbar carries at most fourteen characters. Longer, and it
   becomes a `Menu` whose trigger names the category.
6. **No destructive actions.** `variant="destructive"` never appears in the toolbar. Destructive
   actions live in menus and confirm through a `Dialog` with `dismissible={false}` when the
   result cannot be undone.
7. **At most one `variant="primary"` control in the window at a time**, and in the toolbar only
   when the screen's single committing action genuinely belongs to the whole screen (Onboarding,
   Admin migration). Otherwise primary belongs to the composer or a panel footer.
8. **Icon-only controls carry a `label`.** `IconButton` requires it; it becomes both the
   `aria-label` and the `title`, so the hover tooltip and the announced name cannot diverge.
9. **Separators are structural, not decorative.** `ToolbarSeparator` only between groups that
   own different scopes. Never more than two in the bar.

### 3.4 The sidebar

`Sidebar` is `<nav>`, 216px, with the translucent chrome fill (`--color-sidebar`) and
`--blur-chrome`. Collapsing animates the width to 52px over `--duration-base` (190ms); labels,
badges and trailing slots are removed from the flow, and `SidebarItem` folds the badge count
into its `aria-label` so a collapsed item still announces "Tasks (3)". A dot appears at the
item's top-right corner in the collapsed state so pending work is visible without the number.

Section titles use `.mrd-panel-title` — small, tracked out (`--text-panel-tracking` 0.045em),
uppercase, tertiary colour. **This is the only uppercase in the product**, plus the `Table`
header cell which uses the same style for the same reason: at 11px, tracked out, uppercase reads
as a label for a region rather than as content inside it. Uppercase anywhere else — a button, a
badge, a status, a title — makes content look like chrome and slows reading.

When the sidebar is collapsed the section titles are visually hidden but keep their accessible
names, and `Layout.css` restores the grouping with a hairline and 12px (`--space-3`) of top
padding between adjacent sections.

Selection is carried by `aria-current="page"`, and the styling hangs off that attribute rather
than a class, so the visual state and the announced state can never drift.

### 3.5 The main column

The main column always contains exactly one `Panel` or one `SplitPane` of `Panel`s. `Panel` is a
flex column with `min-width: 0` and `min-height: 0` released on both axes, so a `PanelBody`
child takes the remaining height and scrolls inside the rounded corners while the header and
footer stay put. The shell never scrolls: `base.css` sets `overflow: hidden` on `body`.

### 3.6 The drawer

There is no `Drawer` primitive. The drawer is a vertical `SplitPane` inside the main column
whose second pane holds a `Panel` with a `variant="label"` header:

```tsx
<SplitPane
  direction="vertical"
  sizes={[1 - drawerFraction, drawerFraction]}
  minSizes={[0.25, 0.12]}
  onSizesChange={setSizes}
  separatorLabel={() => 'Resize drawer'}
>
  <Panel elevation={0}>{content}</Panel>
  <Panel elevation={0}>
    <PanelHeader variant="label" title="Terminal" actions={<IconButton label="Close drawer" icon={<CloseGlyph />} onClick={close} />} />
    <PanelBody padded={false} scroll>{drawer}</PanelBody>
  </Panel>
</SplitPane>
```

`--drawer-height` (260px) is the resting height. Because `SplitPane` works in fractions, the
screen converts once on open — `260 / containerHeight` — and stores the fraction thereafter, so
the drawer keeps its share of the window when the window changes.

The drawer holds one of: the terminal, the task log, the routing trace, or the diff review
queue. Only one at a time, selected by a `Tabs variant="pill"` row in the drawer's own header.
Below the `md` breakpoint (900px) the drawer becomes a `Sheet side="bottom"`.

### 3.7 The inspector

`Inspector` is `<aside>`, fixed at 340px (`--inspector-width`), holding the properties of
whatever is selected in the main column. Its width is fixed by token and the centre is the
column that flexes: the inspector holding still while the content resizes is what makes a
selection feel like it is being examined rather than moved.

Its body is a `PanelBody` with a 20px (`--space-5`) gap between children, which is the rhythm a
column of `KeyValue` blocks, `Fieldset`s and `Meter`s wants.

The inspector is never the only place an action lives. Anything reachable there must also be
reachable from the row's context menu, because the inspector is the first region to leave the
layout on a narrow viewport.

### 3.8 The status bar

`StatusBar` is 26px, a three-column grid so the centre slot is centred on the bar rather than on
what is left over. It carries **standing facts only** — connection state, the active route, the
day's spend, the selected routing mode, cursor position in the editor. It is not a live region:
announcing every change to a token counter would make the app unusable with a screen reader.
Anything that genuinely needs announcing is a `Toast` or carries its own `aria-live`.

Numbers in the status bar carry `.mrd-numeric` (tabular figures) so a counter updating in place
does not shift the text beside it.

### 3.9 Shell states

**Loading (cold start).** The shell chrome renders immediately with real structure and no
content: `Toolbar` with its groups present but controls disabled, `Sidebar` with three
`Skeleton variant="text"` rows per section, main column holding a single
`Skeleton variant="block"` at the panel's full size with `label="Loading workspace"`, status bar
showing `StatusChip status="unknown"`. Never a full-window spinner — the shell's shape is known
before the data is, and showing it is what makes the app feel resident rather than fetched.

**Empty (no workspace, no providers).** The shell routes to Onboarding (§17). It does not render
an empty workspace.

**Error (gateway unreachable).** The status bar's left slot switches to
`StatusChip status="offline"` with the label "Gateway offline". The main column keeps its last
rendered content, dimmed to 42% and non-interactive — the same disabled opacity the buttons
use — and an `EmptyState` overlays it:

```tsx
<EmptyState
  icon={<OfflineGlyph />}
  title="Cannot reach the gateway"
  description="The gateway stopped responding. Requests are queued locally and will be retried."
  action={<Button variant="primary" onClick={retry}>Retry now</Button>}
  secondaryAction={<Button variant="tertiary" onClick={openLogs}>Open logs</Button>}
  live
/>
```

Reconnection is announced once, as a `success` toast, not as a banner that then needs
dismissing.

### 3.10 Shell keyboard map

| Shortcut | Action |
| --- | --- |
| `mod+k` | Command palette (§19) |
| `mod+b` | Toggle sidebar collapsed |
| `mod+alt+i` | Toggle inspector |
| `mod+j` | Toggle drawer |
| `mod+1` … `mod+9` | Jump to the nth sidebar item |
| `mod+,` | Settings |
| `mod+shift+m` | Routing-mode picker |
| `mod+/` | Keyboard shortcut reference (`Dialog size="lg"`) |
| `Escape` | Close the topmost dismissible layer — already handled by the overlay stack |
| `F6` / `shift+F6` | Move focus to the next / previous shell region |

Shortcuts are declared in `matchesShortcut` form (`"mod+shift+m"`) and rendered with
`formatShortcut`, which produces `⌘⇧M` on Apple platforms and `Ctrl+Shift+M` elsewhere. A
shortcut shown in a menu goes on `MenuItem`'s `shortcut` prop, which also sets
`aria-keyshortcuts`; a shortcut shown anywhere else uses `<Kbd shortcut="mod+k" />`.

### 3.11 Responsive behaviour

Breakpoints from `tokens.css`: `--breakpoint-sm` 640px, `--breakpoint-md` 900px,
`--breakpoint-lg` 1200px, `--breakpoint-xl` 1600px. Mirrored in `tokens.ts` as `breakpoint`.

| Range | Sidebar | Main | Inspector | Drawer | Status bar |
| --- | --- | --- | --- | --- | --- |
| ≥ 1600 (xl) | 216px, expanded | flexes | 340px, in flow | in flow, 260px | full three slots |
| 1200–1599 (lg) | 216px or 52px, user's choice, remembered | flexes | 340px, in flow | in flow | full three slots |
| 900–1199 (md) | 52px, collapsed by default | flexes | `Sheet side="right"` (388px), opened from the toolbar | in flow, min 0.12 of the column | left and right slots only |
| 640–899 (sm) | `Sheet side="bottom"` behind the toolbar toggle | full width | `Sheet side="bottom"` | `Sheet side="bottom"` | left slot only |
| < 640 | `Sheet side="bottom"` | full width | `Sheet side="bottom"` | `Sheet side="bottom"` | hidden |

`SheetSide` is `'right' | 'bottom'` — there is no left sheet. On narrow viewports the navigation
therefore opens as a bottom sheet, not as a left drawer. Do not fake a left sheet with a
`Dialog`: `Sheet` already carries the focus trap, scroll lock and Escape handling that a
navigation overlay owes a keyboard user.

Below 900px the three-panel `SplitPane` collapses to a single pane. Fractions are kept in
preferences and restored when the viewport widens again, so resizing the window back does not
lose the user's layout.

---

## 4. Cross-screen state recipes

Every screen below refers to these. They are specified once so the twelve screens agree.

### 4.1 Empty

`EmptyState`, centred in whatever region is empty, always ending in an action. Its description
is capped at a 42-character measure and must say what to do next, not apologise.

- **Region empty** (a panel inside a populated screen): `size="sm"`, no `headingLevel` — the
  panel header already names the region.
- **Screen empty** (nothing has been created yet): `size="md"`, `headingLevel={2}`, one
  `variant="primary"` action.
- **Filtered to nothing**: `size="sm"`, `live` so the change is announced, action is
  "Clear filters" at `variant="secondary"`. Never the same copy as the never-created case — "No
  results for 'gpt-5'" and "No models yet" are different facts and different fixes.

### 4.2 Loading

Loading is skeletal, not spun. The shape of what is coming is drawn with `Skeleton` at the real
row height, so nothing moves when the data lands.

- Lists: `Skeleton variant="text" lines={n}`; the last line is short, the way a paragraph ends.
- Tables: `Table` takes `loading` and `skeletonRows` (default 5) and renders them itself. Pass
  `loadingLabel` when "Loading" is not specific enough.
- Whole panels: one `Skeleton variant="block"` with a `label`, which makes it
  `role="status" aria-live="polite"`. Without a `label` a skeleton is `aria-hidden` — correct,
  because twenty announced placeholders are noise.
- Streaming (a chat turn, a running step): `Progress indeterminate` with a real `label`. An
  indeterminate bar omits `aria-valuenow` entirely; that absence is what tells assistive
  technology the amount of work is unknown.
- In-place work on a control: `Button loading`, which keeps the button's width, blocks
  interaction and sets `aria-busy`.

### 4.3 Error

Three tiers, chosen by what the user can still do.

| Tier | Surface | When |
| --- | --- | --- |
| Field | `error` prop on `Input` / `TextArea` / `Select` / `Slider` / `RadioGroup` | the value is wrong and the user is still in the form. Carries a glyph as well as the error colour and `role="alert"` |
| Region | `EmptyState` with an error title and a retry action, inside the failed panel only | one panel's data failed; the rest of the screen is fine |
| Session | `toast({ variant: 'error', ... })` with an `action` | something failed that is not tied to a visible region |

Errors never use colour alone. `StatusChip` draws a distinct silhouette per status — a filled
disc for `ready`, a ringed dot for `healthy`, a half-filled ring for `busy`, a barred ring for
`rate_limited`, a triangle for `degraded`, a struck ring for `offline`, an empty ring for
`unknown`, a cross for `error` — so the state survives greyscale, a pasted screenshot and colour
vision deficiency.

`HealthState` from `@meridian/shared` has six values and `StatusChip`'s `Status` has eight. Map
them explicitly, in one place: `healthy → healthy`, `degraded → degraded`,
`rate_limited → rate_limited`, `offline → offline`, `unknown → unknown`, and
**`unauthorized → error`** with the visible label "Unauthorised". Never silently render
`unauthorized` as `offline`; a missing key and a dead endpoint are different problems with
different fixes.

### 4.4 Destructive confirmation

A `Dialog` with `dismissible={false}` when the action cannot be undone (deleting a credential,
revoking a key, wiping usage history), so neither Escape nor the scrim can answer it by
accident. Footer holds `Button variant="tertiary"` (Cancel) then
`Button variant="destructive"`. `initialFocus` points at Cancel. Destructive reads as
destructive at rest, not only on hover.

When the action *can* be undone, do not confirm at all — act, then `toast` with an "Undo"
action. This is the rule for rejecting a diff hunk, cancelling a task and removing a pool
member.

---

## 5. Home / Recent

### 5.1 Purpose

The first screen after the shell loads. It answers three questions in one glance: what was I
doing, what is the gateway doing now, and what can I start.

### 5.2 Layout

```
┌──────────┬─────────────────────────────────────────────┬──────────────────┐
│ Sidebar  │  ┌───────────────────────────────────────┐  │  Inspector       │
│          │  │ Composer                    (§18)     │  │                  │
│          │  │ ┌───────────────────────────────────┐ │  │  Selected item   │
│          │  │ │ prompt                            │ │  │  ───────────     │
│          │  │ └───────────────────────────────────┘ │  │  KeyValue        │
│          │  │ [mode] [pool] [attach]      [Send ⌘↵] │  │                  │
│          │  └───────────────────────────────────────┘  │  Actions         │
│          │  ┌─────────────────┐ ┌─────────────────┐    │                  │
│          │  │ Continue        │ │ Gateway         │    │                  │
│          │  │ ─────────────── │ │ ─────────────── │    │                  │
│          │  │ List of recent  │ │ 4 providers ●   │    │                  │
│          │  │ workspaces /    │ │ 118 models      │    │                  │
│          │  │ tasks / chats   │ │ Meter: spend    │    │                  │
│          │  └─────────────────┘ └─────────────────┘    │                  │
├──────────┴─────────────────────────────────────────────┴──────────────────┤
│ Status bar                                                                │
└───────────────────────────────────────────────────────────────────────────┘
```

The main column is one `Panel elevation={0}` with an unpadded body holding a 16px-gap `Stack`.
The two lower cards are `Card elevation={0}` in a two-column grid that becomes one column below
900px.

### 5.3 Composition

- Composer at the top (§18), always focused on mount.
- **Continue**: `List size="lg"` (34px rows), `selectable`, one `ListRow` per recent item with
  `icon` for its kind, `secondary` for the relative time, and `trailing` holding a
  `StatusChip size="sm"` for anything still running. `onSelect` fills the inspector;
  Enter opens the item.
- **Gateway**: a `Card` holding `KeyValue` (providers configured, models catalogued, tasks
  running) and one `Meter` for today's spend against `maxCostPerTask`-derived daily cap, with
  `threshold` at 80% so the meter turns `warning` before the cap rather than at it.
- Right column of the inspector: `KeyValue` for the selected recent item, plus
  `Button variant="secondary" fullWidth` actions.

### 5.4 States

**Empty** — a first run that has completed onboarding but has no history:

```tsx
<EmptyState
  icon={<SparkGlyph />}
  title="Nothing here yet"
  description="Start a chat, open a workspace, or run a task. Recent work appears here."
  action={<Button variant="primary" size="lg" onClick={focusComposer}>Start a chat</Button>}
  secondaryAction={<Button variant="secondary" size="lg" onClick={openWorkspace}>Open workspace</Button>}
  headingLevel={2}
/>
```

**Loading** — composer is live immediately (it needs no server data beyond the mode list, which
is a constant); Continue shows six `Skeleton variant="text"` rows at 26px; Gateway shows
`Skeleton variant="block" height={120} label="Loading gateway status"`.

**Error** — the composer stays usable if the model catalogue failed but the gateway is up; the
Gateway card shows a region-tier `EmptyState size="sm"` with "Retry". If the gateway itself is
down, §3.9 applies and Home is not reached.

### 5.5 Keyboard

| Shortcut | Action |
| --- | --- |
| `mod+enter` | Send the composer |
| `mod+n` | New chat |
| `mod+shift+n` | New task |
| `mod+o` | Open workspace |
| `↑` / `↓` | Move within Continue (single tab stop; provided by `List`) |
| `enter` | Open the focused recent item |

### 5.6 Responsive

- ≥1200: two cards side by side, inspector in flow.
- 900–1199: two cards side by side, inspector as a right sheet.
- 640–899: cards stack; composer keeps full width; Continue truncates to five rows with a "Show
  all" `Button variant="tertiary"`.
- <640: composer collapses its option row into one `IconButton` opening a `Menu`; Gateway card
  drops to a single `Meter` and a count.

---

## 6. Workspace

### 6.1 Purpose

Read and change code with agents. The workspace is the densest screen in the product and the one
that most needs the shell to hold still.

### 6.2 Layout

```
┌──────────┬────────────────────────────────────────────┬──────────────────┐
│ Sidebar  │ ┌────────┐ ┌─────────────────────────────┐ │ Inspector        │
│          │ │ Files  ║ │ file.ts × │ diff.ts × │ +   │ │                  │
│          │ │        ║ ├─────────────────────────────┤ │ Symbol / file    │
│          │ │ ▸ src  ║ │                             │ │ KeyValue         │
│          │ │  ▾ ui  ║ │  editor or diff             │ │                  │
│          │ │   file ║ │                             │ │ Changes          │
│          │ │        ║ │                             │ │ ── pending 3     │
│          │ │ 216px  ║ │                             │ │                  │
│          │ └────────┘ ╞═════════════════════════════╡ │ 340px            │
│          │            │ Terminal │ Tasks │ Diffs    │ │                  │
│          │            │ drawer            260px     │ │                  │
├──────────┴────────────────────────────────────────────┴──────────────────┤
│ workspace ▸ branch ▸ 3 changes        AUTO        1.2k tok  $0.04        │
└──────────────────────────────────────────────────────────────────────────┘
```

Two nested `SplitPane`s: a horizontal one splitting the file tree from the editor stack, and a
vertical one inside the editor stack splitting the editor from the drawer. Minimum sizes matter
here — give the file tree `minSizes[0] = 0.12` so it cannot be dragged to nothing, and the
editor `0.3`.

### 6.3 File tree

Composed, not a primitive. It is a `List` (not `selectable`; selection is the open file, which
the tab bar owns) whose rows carry their own depth padding:

- One `ListRow` per visible node, `value` = the path from `FileNode.path`.
- `icon` is the disclosure triangle for a directory, the file glyph for a file. Depth is applied
  as `paddingInlineStart` on the row via inline style, in multiples of `--space-3` (12px).
- `trailing` carries a `Badge variant="warning" size="sm"` when the file has pending changes.
- `onActivate` opens a file; a directory row toggles its own expansion.
- Every row is wrapped in a `ContextMenu` with: Open, Open to the Side, Reveal in Terminal,
  Copy Path, Copy Relative Path, Rename, Delete (destructive). `ContextMenu`'s host is
  `display: contents`, so wrapping a row cannot change the row's layout, and it opens from the
  context-menu key and Shift+F10 as well as right-click.
- `←` collapses a directory or moves to the parent; `→` expands or moves to the first child.
  `List` provides `↑`/`↓`/`Home`/`End`; the tree adds the horizontal pair.

Movement clamps at the ends rather than wrapping — a tree that jumps from the last row back to
the first hides the fact that you reached the bottom.

### 6.4 Tabs and the editor

The tab strip is `Tabs variant="underline" activation="manual"` with one `Tab` per open file.
**Manual activation is mandatory here**: an editor panel is expensive to mount, and automatic
activation would open every file the user arrows past. `TabPanel lazy` defers mounting until
first shown and keeps it mounted after.

Each `Tab` carries the filename as its child, a dirty dot via `count` (a `•` when unsaved), and
a close `IconButton size="sm"` in a wrapper beside it — not inside the `Tab`, because a button
inside a button is invalid and unreachable by keyboard.

The editor itself is screen-local. It sits in a `Panel elevation={0}` with
`<PanelBody padded={false} scroll={false}>` because the editor owns its own scrolling and
virtualisation. Its text uses `.mrd-code` — `--font-mono`, `--text-code-size` (12.5px),
`--text-code-line` (19px). 12.5px is deliberate: at 13px the monospace column runs wider than
the proportional body text beside it and the two stop looking like one document.

### 6.5 Diff

See §21 for the full review flow. Inside the workspace, a diff opens as a tab like any file, and
the tab is marked with `count={<Badge variant="warning" size="sm">diff</Badge>}`.

### 6.6 Terminal

Screen-local, in the drawer. A `Panel` with `PanelBody padded={false} scroll`, monospace text
via `.mrd-code`, and a header holding `Tabs variant="pill"` to switch between Terminal, Tasks
and Diffs. Terminal output is not a live region — a stream of announced lines is unusable — but
a non-zero exit code raises a `toast({ variant: 'error' })`.

### 6.7 States

**Empty (no file open):** editor pane shows `EmptyState size="md"` — "No file open" / "Choose a
file from the tree, or press ⌘P to search by name." with `<Kbd shortcut="mod+p" />` in the
description and a "Search files" action.

**Empty (empty workspace):** file tree shows `EmptyState size="sm"` — "This workspace is empty"
with a "Clone a repository" action.

**Loading:** the tree renders 12 `Skeleton variant="text"` rows at `--row-height` (26px); the
editor shows one `Skeleton variant="block"` filling the pane with
`label="Opening src/index.ts"`; the tab strip renders real tabs immediately because the open-file
list is local state.

**Error (file unreadable):** the editor pane shows a region-tier `EmptyState` with the reason
from the gateway and a "Retry" action. Errors that affect the whole workspace — a lost git
lock, a permissions failure — are session-tier toasts with an action that opens the drawer's
Tasks tab.

### 6.8 Keyboard

| Shortcut | Action |
| --- | --- |
| `mod+p` | Quick open by filename |
| `mod+shift+f` | Search across the workspace |
| `mod+s` | Save the active file |
| `mod+w` | Close the active tab |
| `mod+shift+w` | Close all tabs |
| `mod+\` | Split the editor |
| `mod+j` | Toggle drawer |
| `mod+shift+e` | Focus the file tree |
| `mod+shift+d` | Focus the Diffs drawer tab |
| `alt+←` / `alt+→` | Previous / next tab |
| `←` / `→` | Collapse / expand in the tree |

### 6.9 Responsive

- ≥1600: tree + editor + drawer + inspector all in flow.
- 1200–1599: same, sidebar collapsed by default to buy the editor 164px.
- 900–1199: inspector becomes a right sheet; tree keeps its pane but its floor drops to 0.1.
- 640–899: the tree leaves the flow and becomes a bottom sheet opened from the toolbar; the
  editor takes the full column; the drawer becomes a bottom sheet.
- <640: read-only. The editor renders, the composer for the workspace agent renders, but the
  tree, drawer and diff review are all bottom sheets and only one may be open at a time. Do not
  attempt three-way pane resizing on a phone.

---

## 7. Chat

### 7.1 Purpose

A conversation with one model or with whatever the router chooses. Chat is where the routing
decision is most visible and most often questioned, so every assistant turn carries its
provenance.

### 7.2 Layout

```
┌──────────┬────────────────────────────────────────────┬──────────────────┐
│ Sidebar  │ ┌────────────────────────────────────────┐ │ Inspector        │
│ Threads  │ │ Thread title            [⋯]            │ │                  │
│          │ ├────────────────────────────────────────┤ │ Turn details     │
│ ● now    │ │  user turn                             │ │ ───────────      │
│   1h     │ │                                        │ │ model            │
│   Mon    │ │  assistant turn                        │ │ provider         │
│          │ │  ── openrouter:… · 1.4s · $0.0021 ──   │ │ tokens           │
│          │ │  [Why this model?] [Retry] [Copy]      │ │ cost             │
│          │ │                                        │ │ latency          │
│          │ ├────────────────────────────────────────┤ │                  │
│          │ │ Composer                       (§18)   │ │ Why this model?  │
│          │ └────────────────────────────────────────┘ │  (§20)           │
├──────────┴────────────────────────────────────────────┴──────────────────┤
│ AUTO · anthropic:claude-… · 2,481 tok · $0.031                           │
└──────────────────────────────────────────────────────────────────────────┘
```

Thread list lives in the shell sidebar as a `SidebarSection title="Threads"` with one
`SidebarItem` per thread, `badge` showing unread turns.

### 7.3 Turns

A turn is a `Card elevation={0} padded`. User turns and assistant turns differ by alignment and
by fill, not by bubble shape: user turns take `--color-surface-sunken`, assistant turns take
`--color-surface`. Radius is `--radius-lg` (10px) — restrained on purpose. Chat "bubbles" with
pill radii read as a consumer messaging app; a workstation's conversation is a document.

Under every assistant turn, a metadata row at `.mrd-secondary` (12px) with `.mrd-numeric`
figures:

`{model} · {latency} · {cost}` — then three `Button variant="tertiary" size="sm"` controls:
**Why this model?** (opens §20 in the inspector), **Retry** (re-runs the turn, optionally with a
different mode), **Copy**.

If the turn fell back, the fallback notice (§21) sits directly above the metadata row.

Streaming: while tokens are arriving, the assistant `Card` holds a
`Progress indeterminate size="sm" label="Generating response"` at its top edge, and the metadata
row shows only the model. Latency and cost appear when the turn completes — a cost that counts
up while you read is a distraction and, until the turn ends, a guess.

### 7.4 States

**Empty (new thread):**

```tsx
<EmptyState
  icon={<ChatGlyph />}
  title="New conversation"
  description="Ask anything. Meridian picks a model for the job, or pin one from the composer."
  headingLevel={2}
/>
```

No action button — the composer below is the action, and a duplicate button above it is noise.

**Loading (opening a thread):** three alternating `Skeleton variant="text" lines={3}` blocks at
the turn width. The composer is live immediately.

**Error (generation failed):** the assistant `Card` renders in place with
`StatusChip status="error"`, the provider's message, and two actions — `Retry` (same route) and
`Retry with fallback` (next entry in `RoutingDecision.fallbackChain`). Never delete the failed
turn: the user needs to see what was attempted.

**Error (thread failed to load):** region-tier `EmptyState` in the turn area; the thread stays
in the sidebar.

### 7.5 Keyboard

| Shortcut | Action |
| --- | --- |
| `mod+enter` | Send |
| `shift+enter` | Newline |
| `mod+n` | New thread |
| `mod+shift+r` | Retry the last turn |
| `mod+shift+y` | Open "Why this model?" for the last turn |
| `↑` in an empty composer | Load the previous user message for editing |
| `mod+f` | Find in thread |

### 7.6 Responsive

- ≥1200: three columns; the inspector holds turn details permanently.
- 900–1199: inspector becomes a right sheet, opened by "Why this model?" and by turn selection.
- 640–899: threads move into a bottom sheet; turns take the full width with a 68ch measure.
- <640: metadata row wraps to two lines; the three per-turn actions collapse into one
  `IconButton` opening a `Menu`.

---

## 8. Tasks and the task timeline

### 8.1 Purpose

An agent task is a plan that executed. This screen shows what was planned, what ran, on which
model, at what cost, and what it changed — with enough detail to trust it or to stop it.

### 8.2 Layout

```
┌──────────┬────────────────────────────────────────────┬──────────────────┐
│ Sidebar  │ ┌────────────────────────────────────────┐ │ Inspector        │
│          │ │ Task title              running  [Stop]│ │                  │
│          │ ├────────────────────────────────────────┤ │ Estimate         │
│          │ │ Estimate: 6 calls · 3 models · ~28s    │ │ ───────────      │
│          │ │ ~14k tokens · ~$0.04 · CHEAP_FIRST     │ │ calls    6       │
│          │ ├────────────────────────────────────────┤ │ models   3       │
│          │ │ ○ Plan                        0.9s  ▸  │ │ tokens   14,200  │
│          │ │ ● Finding files               1.4s  ▾  │ │ cost     $0.04   │
│          │ │   └ details panel                      │ │                  │
│          │ │ ○ Implement                      —     │ │ Usage            │
│          │ │ ○ Test                           —     │ │ Files touched    │
│          │ └────────────────────────────────────────┘ │                  │
├──────────┴────────────────────────────────────────────┴──────────────────┤
│ 2 of 6 steps · 4 tool calls · $0.012                                     │
└──────────────────────────────────────────────────────────────────────────┘
```

### 8.3 Composition

The task list (all tasks, not one) is a `Table` with columns: Title, Status, Lane, Mode, Started,
Duration, Cost. `sortable` on Started, Duration and Cost. `onSelectRow` opens the task; the
selected row keeps the roving tab stop.

One task is a `Panel` whose body holds:

1. **The estimate strip.** `TaskEstimate` rendered as a `KeyValue layout="row"` line with
   `numeric` on every figure, produced before execution. If `estimate.freeAvailable` is true and
   the chosen strategy is not a free one, add a `Badge variant="success">Free route available`
   with a "Switch to FREE" action. If `estimate.note` is present, show it at `.mrd-caption`.
2. **The timeline.** `Timeline` with one `TimelineStep` per `TaskStep`:

```tsx
<Timeline label="Task steps">
  {steps.map((step) => (
    <TimelineStep
      key={step.id}
      status={step.status}
      label={step.label}
      meta={`${step.role} · ${step.modelId ?? 'unrouted'}`}
      duration={step.latencyMs != null ? `${(step.latencyMs / 1000).toFixed(1)}s` : undefined}
      details={<StepDetails step={step} />}
    />
  ))}
</Timeline>
```

`TimelineStep.status` is `StepStatus` from `@meridian/shared` — `pending`, `running`,
`completed`, `failed`, `skipped` — and each has its own glyph: an empty ring, a live dot, a
check, a cross, a dash. The connector below a step fills with the accent once the step is behind
us, which is what makes the rail read as progress rather than decoration. Passing `details`
makes a step expandable; a step without details is not expandable, so do not pass an empty
fragment to make the chevrons line up.

The details panel of a step holds: the summary (`TaskStep.summary`, never raw chain-of-thought),
`KeyValue` for model / provider / tokens / cost / tool calls, the files it touched as a `List
size="sm"`, and any `FallbackEvent`s as fallback notices (§21).

### 8.4 States

**Empty (no tasks):** `EmptyState size="md"`, "No tasks yet" / "Describe what you want done and
Meridian will plan it, run it, and show you every step.", action "New task".

**Empty (task queued, no steps yet):** the timeline area shows a single
`TimelineStep status="pending" label="Planning"` — not a skeleton. A queued task genuinely has
one known step, and showing it is more honest than a placeholder.

**Loading (opening a completed task):** timeline shows five `Skeleton variant="text"` rows at
34px; the estimate strip shows `Skeleton variant="line" width={220}`.

**Awaiting input:** `TaskStatus` includes `awaiting-input`. The panel footer becomes a prompt:
`StatusChip status="busy"` plus the question, an `Input`, and `Button variant="primary"`
("Continue"). The task row in the list carries a `Badge variant="warning"` reading "Needs you", and the
sidebar item's badge count includes it. This state must also raise one `toast` with an action
that jumps to the task — a task blocked on a question the operator never saw is the single
worst failure mode of an agent runner.

**Failed:** the failing `TimelineStep` renders `status="failed"` and auto-expands. The panel
header shows `StatusChip status="error"`, and the footer offers "Retry from this step" and
"Retry whole task".

**Cancelled:** remaining steps render `status="skipped"`. Nothing is hidden.

### 8.5 Keyboard

| Shortcut | Action |
| --- | --- |
| `mod+shift+n` | New task |
| `↑` / `↓` | Move between task rows (`Table` roving tab stop) |
| `enter` | Open the focused task |
| `space` | Expand / collapse the focused timeline step |
| `mod+.` | Stop the running task |
| `mod+shift+r` | Retry from the selected step |

### 8.6 Responsive

- ≥1200: task list and detail side by side via `SplitPane`, inspector in flow.
- 900–1199: list and detail side by side; inspector as a right sheet.
- 640–899: list and detail become two `Tabs variant="pill"` panels in one column.
- <640: timeline steps drop their `meta` line and keep label, glyph and duration. Duration keeps
  `.mrd-numeric` so the column still aligns.

---

## 9. Agents

### 9.1 Purpose

Configure the nine agent roles — `orchestrator`, `planner`, `file-finder`, `researcher`,
`browser`, `implementer`, `tester`, `reviewer`, `debugger` — and see how each one is routed.

### 9.2 Layout

```
┌──────────┬────────────────────────────────────────────┬──────────────────┐
│ Sidebar  │ ┌──────────────┐ ┌───────────────────────┐ │ Inspector        │
│          │ │ Roles        │ │ Implementer           │ │                  │
│          │ │ ──────────── │ │ ───────────────────── │ │ Live routing     │
│          │ │ orchestrator │ │ Fieldset: Routing     │ │ ───────────      │
│          │ │ planner      │ │  task type   coding   │ │ last model       │
│          │ │ file-finder  │ │  mode        BEST     │ │ last latency     │
│          │ │ researcher   │ │  pool        coding   │ │ 24h calls        │
│          │ │ browser      │ │  max steps   [——●—]   │ │ 24h cost         │
│          │ │ implementer ✓│ │ Fieldset: Tools       │ │                  │
│          │ │ tester       │ │  ☑ read  ☑ write      │ │                  │
│          │ │ reviewer     │ │ Fieldset: Prompt      │ │                  │
│          │ │ debugger     │ │  TextArea             │ │                  │
│          │ └──────────────┘ └───────────────────────┘ │                  │
└──────────┴────────────────────────────────────────────┴──────────────────┘
```

### 9.3 Composition

- Role list: `List selectable value={role} onSelect={setRole} size="lg"`, one `ListRow` per
  `AgentRole`, `secondary` showing the role's `preferredMode`, `trailing` a
  `StatusChip size="sm" hideLabel` for whether its pool is healthy.
- Detail: `Fieldset`s, one per concern.
  - **Routing** — `FormRow` for task type (`Select` over `TASK_TYPES`), mode (`Select` over
    `ROUTING_MODES`), pool (`Select` over configured pools), and max steps
    (a `Slider` with `min={1}`, `max={40}`, `showValue`, and a `formatValue` that appends
    " steps"). `formatValue` also becomes `aria-valuetext`, so the slider announces "12 steps",
    not "12".
  - **Capabilities** — `Checkbox` per `Capability` the role requires. Required capabilities
    filter the model set, so show the resulting count live: "18 of 118 models qualify".
  - **Tools** — `Checkbox` per tool in `AgentDefinition.tools`.
  - **System prompt** — `TextArea rows={8} fullWidth` inside a `Field`, with a `footnote` on the
    `Fieldset` giving the token cost of the prompt.
- Changes are saved by an explicit `Button variant="primary"` in the `Panel` footer, not on
  blur. An agent definition is configuration that changes how money is spent; it gets a commit
  step.

### 9.4 States

**Empty:** never empty. The nine roles are a constant, and a role with no configuration renders
its defaults with a `Badge variant="neutral"` reading "Default" beside its name.

**Loading:** role list renders immediately from the constant; the detail panel shows
`Skeleton variant="text" lines={6}` per `Fieldset` while the saved overrides load.

**Error (save failed):** `toast({ variant: 'error' })` with a "Retry" action; the form keeps the
user's edits and the footer's primary button returns from `loading` to enabled. Never discard
input on a failed save.

**Disabled:** a role whose pool has been deleted renders its `Fieldset disabled` (which disables
every control inside, natively) plus a region `EmptyState size="sm"` — "Pool 'coding' no longer
exists" with a "Choose a pool" action.

### 9.5 Keyboard

`↑`/`↓` move the role list. `mod+s` saves. `mod+enter` inside the prompt `TextArea` saves and
returns focus to the list. Tab order runs list → fieldsets in order → footer.

### 9.6 Responsive

- ≥1200: list + detail + inspector.
- 900–1199: list + detail; inspector as a sheet.
- <900: the role list becomes a `Select` at the top of the detail panel — nine items is a
  choice, not a navigation structure, and a `Select` inherits the platform picker on touch.

---

## 10. Models

Three views over the same catalogue: browse, detail, compare.

### 10.1 Browse

**Purpose.** Find a model out of a catalogue that is routinely in the hundreds, filtered by what
the job actually needs.

```
┌──────────┬─────────────────────────────────────────────┬─────────────────┐
│ Sidebar  │ ┌─────────────────────────────────────────┐ │ Inspector       │
│          │ │ [Search models          ] [Table|Grid]  │ │                 │
│          │ ├─────────────────────────────────────────┤ │ claude-…        │
│          │ │ Chat│Coding│Vision│Free│Local   (pills) │ │ ──────────      │
│          │ ├─────────────────────────────────────────┤ │ Stars: coding   │
│          │ │ MODEL      PROVIDER  CTX  IN$  OUT$  ●  │ │ Stars: reasoning│
│          │ │ ───────────────────────────────────────  │ │ KeyValue        │
│          │ │ claude-…   anthropic 200k 3.00 15.0  ●  │ │ Capabilities    │
│          │ │ llama-…    ollama      8k    —    —  ●  │ │ Pricing         │
│          │ │ gpt-…      openai    128k 2.50 10.0  ◐  │ │ [Pin to route]  │
│          │ └─────────────────────────────────────────┘ │                 │
└──────────┴─────────────────────────────────────────────┴─────────────────┘
```

**Composition.**

```tsx
const columns: TableColumn<ModelDescriptor>[] = [
  { key: 'name', header: 'Model', render: (m) => <ModelName model={m} /> },
  { key: 'provider', header: 'Provider', width: '9rem', render: (m) => m.providerId },
  { key: 'context', header: 'Context', width: '6rem', align: 'end', sortable: true,
    render: (m) => <span className="mrd-numeric">{formatContext(m.contextLength)}</span> },
  { key: 'in', header: 'In / Mtok', width: '7rem', align: 'end', sortable: true,
    render: (m) => <Price value={m.pricing.inputPerMTok} /> },
  { key: 'out', header: 'Out / Mtok', width: '7rem', align: 'end', sortable: true,
    render: (m) => <Price value={m.pricing.outputPerMTok} /> },
  { key: 'status', header: 'Status', width: '7rem',
    render: (m) => <StatusChip status={m.status} size="sm" /> },
];

<Table
  columns={columns}
  rows={models}
  rowKey={(m) => m.id}
  caption="Model catalogue"
  stickyHeader
  sort={sort}
  onSortChange={setSort}
  selectedKey={selected}
  onSelectRow={(model) => setSelected(model.id)}
  loading={loading}
  skeletonRows={8}
  empty={<EmptyState size="sm" title="No models match" description="Loosen a filter or clear the search." action={<Button onClick={clear}>Clear filters</Button>} live />}
  style={{ height: '100%' }}
/>
```

The `style={{ height: '100%' }}` is load-bearing: `Table` owns its horizontal overflow and that
same box is the scrollport the sticky header sticks to, so the header only stays put when the
consumer gives the element a bounded height.

- Search is a `SearchField` in the panel header (`actions` slot), matching id, display name,
  family and tags. Escape clears the field before it reaches anything above it.
- Filters are a `Tabs variant="pill"` row over task types plus a `SegmentedControl` for
  Free / Paid / Local. Pills are the one place a `--radius-pill` (999px) control is correct,
  because a filter chip is a token, not a surface.
- A grid alternative (`Card elevation={0}` per model, `selected` for the current one) is offered
  via a `SegmentedControl` with two options. Table is the default; a grid of 118 cards is a
  wall, and only earns its place when the user is browsing rather than looking.
- Pricing cells: never render `null` as `0`. `PricingKind` distinguishes `FREE`, `FREE_DAILY`,
  `FREE_MONTHLY`, `TRIAL`, `CREDIT`, `FLAT`, `RESERVATION`, `METERED`, `LOCAL`, `PAID` and
  `UNKNOWN`, and the UI must too: a promotional credit is never labelled the same as a permanent
  free tier. Render the kind as a `Badge` — `success` for the four non-spending kinds
  (`FREE`, `FREE_DAILY`, `FREE_MONTHLY`, `LOCAL`), `warning` for `TRIAL` and `CREDIT`,
  `neutral` for `UNKNOWN` — and put `pricing.note` in a `Tooltip` on it.

**States.** Empty (no catalogue) → `EmptyState size="md"`, "No models discovered" / "Add a
provider, then run discovery.", action "Add provider". Empty (filtered) → the `empty` prop
above, `live`. Loading → `Table loading`. Error → region `EmptyState` inside the table's box with
the provider that failed named, plus "Retry discovery".

**Keyboard.** `mod+f` focuses search; `↑`/`↓` move rows; `enter` opens detail; `space` pins the
focused model to the composer's route; `mod+shift+c` opens compare with the selected rows.

**Responsive.** ≥1200 table with all six columns. 900–1199 drop Provider (it is in the model
name's `secondary` line) and the inspector goes to a sheet. 640–899 the table becomes a
`List size="lg"` — a horizontally scrolling table on a narrow screen is a table nobody reads.
<640 same list, `secondary` reduced to provider and price kind.

### 10.2 Detail

**Purpose.** Everything known about one model, including the things that decide routing.

```
┌────────────────────────────────────────────────────────────────┐
│ claude-…                            anthropic   ● Ready        │
├────────────────────────────────────────────────────────────────┤
│ Overview │ Scores │ Performance │ Pricing │ Data use           │
├────────────────────────────────────────────────────────────────┤
│  Scores                        Performance                     │
│  Coding    ★★★★☆  82           TTFT        310 ms              │
│  Reasoning ★★★★★  91           Latency     1,240 ms            │
│  General   ★★★★☆  86           p95         2,900 ms            │
│  Tool use  ★★★☆☆  74           Jitter      180 ms              │
│  Vision    —                   Tok/s       58                  │
│  Stability ▓▓▓▓▓▓▓▓░ 0.97      Uptime      ▓▓▓▓▓▓▓▓▓ 0.995     │
│  from 1,204 samples            from 840 samples                │
└────────────────────────────────────────────────────────────────┘
```

**Composition.** `Panel` with `Tabs variant="underline"`. `ModelScores` renders as `Stars` with
`label` and `showValue` — `Stars` announces "Coding: 4 out of 5" and rounds to the nearest half
star. A `null` score renders as an em dash and the word "not measured", never as zero stars: a
model nobody has scored is not a model that scored badly. `ModelScores.samples` and
`ModelPerformance.samples` are always shown at `.mrd-caption`; a score without its sample count
is an unfalsifiable claim.

`stability` and `uptime` are in [0,1] and render as `Meter` with `valueText` giving the real
figure. Capabilities render as `Badge variant="neutral"` chips, one per `Capability`.

**States.** Loading → `Skeleton variant="text" lines={5}` per tab panel, with `TabPanel lazy` so
the panels the user never opens are never mounted or fetched. Error → per-tab region
`EmptyState`. Empty (never measured) → the Scores tab shows `EmptyState size="sm"`, "No scores
yet" / "Scores appear after this model has run a few times."

**Keyboard.** `←`/`→` move tabs (roving, provided by `TabList`); `mod+shift+c` adds this model to
the comparison.

**Responsive.** <900 the two columns stack; the tab list wraps only in the `pill` variant, so
the underline tabs get horizontal scroll via `.mrd-scroll-x` instead of wrapping.

### 10.3 Compare

**Purpose.** Put two to four models side by side on the axes that decide a route.

```
┌────────────────────────────────────────────────────────────────┐
│ Compare                                    [+ Add model]  [×]  │
├──────────────┬──────────────┬──────────────┬───────────────────┤
│              │ claude-…     │ gpt-…        │ llama-…           │
├──────────────┼──────────────┼──────────────┼───────────────────┤
│ Provider     │ anthropic    │ openai       │ ollama            │
│ Context      │      200,000 │      128,000 │             8,192 │
│ In / Mtok    │        $3.00 │        $2.50 │              free │
│ Out / Mtok   │       $15.00 │       $10.00 │              free │
│ Coding       │ ★★★★☆ 82     │ ★★★★☆ 79     │ ★★★☆☆ 61          │
│ Latency      │     1,240 ms │       980 ms │           420 ms  │
│ Status       │ ● Ready      │ ◐ Busy       │ ● Ready           │
└──────────────┴──────────────┴──────────────┴───────────────────┘
```

**Composition.** A `Table` transposed by construction: `rows` are the attributes, `columns` are
the models plus a leading label column. `align: 'end'` on every model column so figures line up
on their last character, with `.mrd-numeric` in the cell renderers. Not sortable — there is no
row order to sort.

Differences are marked, not just displayed: the best value in each numeric row takes
`--color-text-primary` and 500 weight; the rest stay `--color-text-secondary`. Never colour the
winner accent — the accent is reserved for selection, focus, the single primary action and
status, and a table where four cells are accent-blue has no accent left.

**States.** Empty (fewer than two models) → `EmptyState size="sm"`, "Pick two models to compare",
action "Choose models" opening a `Dialog size="lg"` with a `SearchField` and a checkbox list.
Loading → `Table loading skeletonRows={9}`. Error → the failing column renders its cells as an
em dash with a `Tooltip` giving the reason; the comparison stays usable.

**Keyboard.** `mod+shift+c` from Browse; `backspace` on a focused column header removes it;
`escape` closes compare when it is opened as a `Dialog size="lg"`.

**Responsive.** ≥900 in the main column. <900 as a `Dialog size="lg"` with the table scrolling
horizontally inside its own box. Never more than three model columns below 1200px.

---

## 11. Providers

### 11.1 List

**Purpose.** Every provider the gateway knows, its integration maturity, its health, and whether
it has a working credential.

```
┌──────────┬────────────────────────────────────────────┬──────────────────┐
│ Sidebar  │ ┌────────────────────────────────────────┐ │ Inspector        │
│          │ │ Providers      [Search] [+ Add]        │ │                  │
│          │ ├────────────────────────────────────────┤ │ openrouter       │
│          │ │ PROVIDER   KIND  TRUST  KEYS  HEALTH   │ │ ──────────       │
│          │ │ anthropic  llm   verif.   1   ● Healthy│ │ Trust  verified  │
│          │ │ openrouter llm   trusted  2   ◐ Limited│ │ Circuit  closed  │
│          │ │ ollama     local verif.   —   ● Healthy│ │ Latency  610 ms  │
│          │ │ replicate  image unknown  0   ✕ Unauth.│ │ Errors   0.4%    │
│          │ └────────────────────────────────────────┘ │ [Test] [Discover]│
└──────────┴────────────────────────────────────────────┴──────────────────┘
```

**Composition.** `Table` with columns Provider, Kinds, Trust, Credentials, Health. Trust renders
as a `Badge` — `success` for `verified`, `neutral` for `trusted`, `warning` for `unknown`,
`error` for `untrusted`. `SupportState` renders beside the provider name: `supported` shows
nothing (it is the expected case), `experimental` shows a `Badge variant="warning"`,
`not_configured` a `Badge variant="neutral"`, `unavailable` a `Badge variant="error"`. A provider
is only ever shown as supported when an adapter exists and its capabilities were verified
against the live API; the UI must not soften that.

Health uses `StatusChip` with the mapping in §4.3 — including `unauthorized → error`.

**States.** Empty → `EmptyState size="md"`, "No providers configured" / "Add a provider to give
Meridian somewhere to route.", action "Add provider", secondary "Scan environment" (which reads
`ProviderDescriptor.envKeys`). Loading → `Table loading`. Error → session toast; the table keeps
its last good rows and the health column shows `StatusChip status="unknown"` throughout, which
is honest: the states are unknown, not fine.

**Keyboard.** `mod+f` search; `↑`/`↓` rows; `enter` opens detail; `mod+shift+t` tests the
selected provider; `mod+shift+d` runs discovery on it.

**Responsive.** <1200 drop Kinds and Trust into the provider cell's secondary line. <900 becomes
`List size="lg"` with `trailing` holding the `StatusChip`.

### 11.2 Detail

**Purpose.** One provider: what it is, how it authenticates, how it is behaving, and what it does
with the data sent to it.

Tabs (`Tabs variant="underline"`): **Overview**, **Models**, **Credentials**, **Health**,
**Data use**.

- **Overview** — `KeyValue` over `ProviderDescriptor`: id, adapter, base URL (with `copy`),
  auth kind, docs URL, local, discovery support, rate limits. `copy` on any value the operator
  will paste elsewhere; the copy button only appears on hover or focus, so a panel of twenty
  rows is not a wall of chrome.
- **Models** — the browse table (§10.1) filtered to this provider, plus a
  `Button variant="secondary"` "Run discovery" that is disabled with a `Tooltip` explaining why
  when `supportsDiscovery` is false. A disabled control with no explanation is a dead end.
- **Credentials** — §11.3.
- **Health** — `ProviderHealth` as `KeyValue` plus three `Meter`s: error rate (`threshold` at
  0.05 so it turns `warning` before it turns bad), consecutive failures, rolling latency. The
  circuit breaker state (`closed` / `open` / `half_open`) is a `Badge`: `success`, `error`,
  `warning`. When `cooldownUntil` is in the future, show a `Progress` counting the cooldown down
  with `valueText` giving the real remaining time.
- **Data use** — `DataUsePolicy` is tri-state on purpose. `allowed`, `not_allowed` and `unknown`
  each get their own presentation, and **`unknown` is never rendered as either of the other
  two**: a `Badge variant="neutral"` reading "Unknown" with the `policyUrl` beside it. Retention
  and the privacy note render as prose at `.mrd-secondary`.

**States.** Loading → per-tab skeletons, `TabPanel lazy`. Error (health check failed) → the
Health tab shows the last known values greyed with a caption giving `lastCheckedAt`, plus a
"Check now" action. Never blank a panel because a refresh failed.

**Keyboard.** `←`/`→` tabs; `mod+shift+t` test connection; `mod+e` edit the provider.

**Responsive.** <900 the tab list scrolls horizontally; `KeyValue` switches to
`layout="stacked"`, which puts the label above the value and stops long base URLs from
truncating to uselessness.

### 11.3 Credentials

**Purpose.** Manage keys without ever showing one.

```
┌──────────────────────────────────────────────────────────────────┐
│ Credentials                                        [+ Add key]   │
├──────────────────────────────────────────────────────────────────┤
│ LABEL              SCOPE      SOURCE      HINT   PRI  USED       │
│ ────────────────────────────────────────────────────────────────  │
│ Personal key       user       user-ent.   ··4f21  10  2 min ago  │
│ CI key             workspace  environment ··9a03   5  1 h ago    │
│ Shared pool key    admin      admin       ··c7be   1  —          │
└──────────────────────────────────────────────────────────────────┘
```

**Composition.** `Table` over `CredentialRecord`. `hint` is the last four characters and is the
**only** part of a secret the UI ever renders — the full secret never leaves the server, so there
is no reveal affordance to build and none must be added. Scope renders as a `Badge`, ordered by
`CREDENTIAL_SCOPE_ORDER` (`request`, `user`, `workspace`, `admin`, `system`, `managed`,
`anonymous`), and the table sorts by that order by default so the resolution precedence is
visible as row order.

Adding a key is a `Dialog size="sm"`:

```tsx
<Dialog
  open={open}
  onOpenChange={setOpen}
  title="Add credential"
  description="The secret is encrypted on the gateway and never sent back to this client."
  size="sm"
  initialFocus={labelRef}
  footer={
    <>
      <Button variant="tertiary" onClick={() => setOpen(false)}>Cancel</Button>
      <Button variant="primary" loading={saving} onClick={save}>Add credential</Button>
    </>
  }
>
  <Field label="Label" description="How you will recognise this key later.">
    <Input ref={labelRef} fullWidth placeholder="Personal OpenRouter key" />
  </Field>
  <Field label="Secret" error={error}>
    <Input type="password" fullWidth autoComplete="off" spellCheck={false} />
  </Field>
  <Field label="Scope">
    <Select fullWidth defaultValue="user">
      <option value="user">User — only me</option>
      <option value="workspace">Workspace — this workspace</option>
      <option value="admin">Admin — everyone on this gateway</option>
    </Select>
  </Field>
</Dialog>
```

Deleting is destructive and irreversible: a `Dialog` with `dismissible={false}`, per §4.4.
Disabling is not — it is a `Switch` in the row's `trailing` slot, applied immediately, with an
undo toast.

**States.** Empty → `EmptyState size="sm"`, "No credentials for this provider" / "Add a key, or
let Meridian scan the environment for one.", actions "Add key" and "Scan environment". Loading →
`Table loading skeletonRows={3}`. Error (validation failed on save) → `error` on the Secret
`Field`, which marks the control invalid and announces through `role="alert"` while the user is
still in the dialog; the dialog does not close.

**Keyboard.** `mod+enter` submits the dialog; `escape` cancels (except when
`dismissible={false}`); `delete` on a focused row opens the delete confirmation.

**Responsive.** <900 the table becomes a `List size="lg"` with `secondary` = scope + hint and
`trailing` = the enable `Switch`. The dialog is `size="sm"` (340px) at every width; it does not
need more.

---

## 12. Pools

### 12.1 List

**Purpose.** Inference pools are named routing policies over a set of models. This screen shows
what exists, what it costs and whether it is healthy.

```
┌──────────┬────────────────────────────────────────────┬──────────────────┐
│ Sidebar  │ ┌────────────────────────────────────────┐ │ Inspector        │
│          │ │ Pools                       [+ New]    │ │                  │
│          │ ├────────────────────────────────────────┤ │ coding           │
│          │ │ ┌────────────┐ ┌────────────┐          │ │ ──────────       │
│          │ │ │ coding  ⛭  │ │ cheap      │          │ │ Strategy         │
│          │ │ │ BEST       │ │ CHEAP_FIRST│          │ │ QUALITY_FIRST    │
│          │ │ │ 4 members  │ │ 9 members  │          │ │ Members  4       │
│          │ │ │ $4.20/$10  │ │ free       │          │ │ Budget           │
│          │ │ │ ▓▓▓▓▓░░░░  │ │ ░░░░░░░░░  │          │ │ ▓▓▓▓░░ 42%       │
│          │ │ └────────────┘ └────────────┘          │ │ [Edit] [Reserve] │
│          │ └────────────────────────────────────────┘ │                  │
└──────────┴────────────────────────────────────────────┴──────────────────┘
```

**Composition.** One `Card elevation={0} onClick={...} selected={...}` per `InferencePool`.
Giving a `Card` an `onClick` makes it a control — it gains `role="button"`, a tab stop, Enter and
Space activation, and a 1px hover lift — and it stays a `div` with that role rather than a
native `<button>` precisely because a pool card carries its own buttons and a nested button is
invalid and unreachable by keyboard.

Each card holds: name, `Badge` for `strategy` (the `RoutingMode`), member count, a `Meter` of
spend against `dailyBudget` with `threshold` at 80%, and a `StatusChip` summarising member
health. A `builtin` pool shows a `Badge variant="neutral"` reading "Built-in" and hides Delete —
built-in pools can be edited but never deleted, and the UI must not offer an action the server
will refuse.

**States.** Empty → never truly empty (built-in pools exist), but a gateway with only built-ins
shows an `EmptyState size="sm"` below the cards: "No custom pools" / "Create a pool to give a
group of models one routing policy.", action "New pool". Loading → six
`Skeleton variant="block" height={120}`. Error → session toast, cards keep last known values with
the meters greyed.

**Keyboard.** `↑`/`↓`/`←`/`→` move between cards (screen-local grid roving); `enter` opens the
editor; `mod+shift+n` new pool.

**Responsive.** ≥1600 four cards per row; 1200–1599 three; 900–1199 two; <900 one, and the
inspector becomes a bottom sheet.

### 12.2 Editor

**Purpose.** Define a pool's members, their priority, and the money it may spend.

```
┌─────────────────────────────────────────────────────────────────┐
│ Edit pool — coding                                              │
├─────────────────────────────────────────────────────────────────┤
│ Fieldset: Identity                                              │
│   Name          [coding                    ]                    │
│   Description   [                          ]                    │
│   Strategy      [QUALITY_FIRST         ▾]                       │
├─────────────────────────────────────────────────────────────────┤
│ Fieldset: Members                              [+ Add model]    │
│   ⠿ claude-…      priority [10] weight [—]  ☑ enabled    [×]    │
│   ⠿ gpt-…         priority [ 8] weight [—]  ☑ enabled    [×]    │
│   ⠿ llama-…       priority [ 2] weight [—]  ☐ enabled    [×]    │
├─────────────────────────────────────────────────────────────────┤
│ Fieldset: Limits                                                │
│   Max concurrency   [———●————]  8                               │
│   Daily budget      [$10.00      ]                              │
│   Fallback pool     [cheap             ▾]                       │
├─────────────────────────────────────────────────────────────────┤
│                                     [Cancel]  [Save pool]       │
└─────────────────────────────────────────────────────────────────┘
```

**Composition.** `Dialog size="lg"` (680px) when opened from a card, or the main column on a
dedicated route. Three `Fieldset`s; each row is a `FormRow` so the label sits left and the
control right with a hairline between consecutive rows. `FormRow`'s label is a `<span>` wired
with `aria-labelledby` rather than a `<label for>`, because the control on the right is as often
a `Switch` — a button — as a native input, and `<label for>` pointed at a button names nothing.

Member rows are a `List` (not `selectable`) with drag handles for priority order. Because
`PoolMember.priority` is an explicit number, drag order and the number must be kept in sync: the
drag writes the number, and the number is also editable directly in an `Input size="sm"` so
keyboard users are not forced to drag. Reordering by keyboard is `alt+↑` / `alt+↓` on a focused
row.

Limits: `Slider` for `maxConcurrency` with `formatValue` producing "8 concurrent",
`Input type="number"` for `dailyBudget` with a `$` `adornment`, and a `Select` for
`fallbackPoolId` whose options exclude this pool (a pool cannot fall back to itself; do not
offer the option and then reject it).

**States.** Empty (no members) → inside the Members `Fieldset`, an `EmptyState size="sm"`: "No
models in this pool" / "A pool with no members never routes.", action "Add model". This wording
matters — an empty pool is not a neutral state, it is a broken one. Loading → the dialog opens
immediately with skeleton rows in Members; identity fields are populated from the card, which is
already loaded. Error (save rejected) → `error` on the offending `Field`, plus a session toast if
the failure is not attributable to one field. The dialog stays open with the user's edits.

**Keyboard.** `mod+enter` saves; `escape` cancels; `alt+↑`/`alt+↓` reorder; `delete` removes the
focused member with an undo toast.

**Responsive.** ≥900 `Dialog size="lg"`. <900 `Sheet side="bottom"` — a 680px dialog on a 640px
viewport is a dialog with no margins. The member row wraps priority and weight onto a second
line.

### 12.3 Reservations

**Purpose.** Book capacity and budget on a pool for a window of time.

```
┌─────────────────────────────────────────────────────────────────┐
│ Reservations — coding                          [+ Reserve]      │
├─────────────────────────────────────────────────────────────────┤
│  now ────────────────────────────────────────────────▶          │
│  ┌──────────────┐        ┌────────────────┐                     │
│  │ nightly eval │        │ release week   │                     │
│  │ active       │        │ scheduled      │                     │
│  └──────────────┘        └────────────────┘                     │
├─────────────────────────────────────────────────────────────────┤
│ LABEL          WINDOW            CONC  BUDGET   USED    STATUS  │
│ nightly eval   02:00–04:00       4     $2.00    $0.84   ● Active│
│ release week   Mon–Fri 09:00     8     $40.00   —       ○ Sched.│
│ old backfill   12 Aug            2     $5.00    $5.00   ✕ Expired│
└─────────────────────────────────────────────────────────────────┘
```

**Composition.** A screen-local timeline strip (absolutely positioned blocks on a proportional
rail, built with tokens — `--color-accent-subtle` fill, `--radius-sm` corners, `--color-border`
hairline) above a `Table` over `Reservation`. Status renders as a `Badge`: `scheduled` neutral,
`active` success, `expired` neutral, `cancelled` warning. `used` and `spend` carry
`.mrd-numeric`.

Creating one is a `Dialog size="md"` with `Field`s for label, start, end, `maxConcurrency`,
`budget`, `fallbackPoolId` and a model multi-select (`Checkbox` list over the pool's members;
empty means all members, and the empty state says so).

**States.** Empty → `EmptyState size="sm"`, "No reservations" / "Reserve capacity when you know a
job is coming.", action "Reserve". Loading → `Table loading skeletonRows={3}` and a skeleton
rail. Error → region `EmptyState` with retry; the rail hides rather than showing a wrong
timeline. A wrong picture of time is worse than no picture.

**Keyboard.** `↑`/`↓` rows; `enter` edits; `delete` cancels a `scheduled` reservation (undo
toast); an `active` reservation cancels through a `dismissible={false}` confirmation, because
stopping running capacity cannot be undone.

**Responsive.** <1200 the rail collapses to a single "now" marker with counts either side. <900
the table becomes a `List size="lg"`.

---

## 13. Generations

### 13.1 Purpose

Image, video and audio work. One screen, three modes, because the queue, the cost accounting and
the asset handling are identical and only the parameters differ.

### 13.2 Layout

```
┌──────────┬────────────────────────────────────────────┬──────────────────┐
│ Sidebar  │ ┌────────────────────────────────────────┐ │ Inspector        │
│          │ │ [ Image │ Video │ Audio ]  segmented   │ │                  │
│          │ ├────────────────────────────────────────┤ │ Parameters       │
│          │ │ Composer (§18) + modality parameters   │ │ ──────────       │
│          │ ├────────────────────────────────────────┤ │ size  1024×1024  │
│          │ │ Queue                                  │ │ steps [——●———]   │
│          │ │ ▓▓▓▓▓▓░░ running  gen-4  0:12          │ │ seed  [ 42     ] │
│          │ ├────────────────────────────────────────┤ │                  │
│          │ │ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐        │ │ Result           │
│          │ │ │ img │ │ img │ │ img │ │ img │        │ │ model / cost     │
│          │ │ └─────┘ └─────┘ └─────┘ └─────┘        │ │ [Save] [Reuse]   │
│          │ └────────────────────────────────────────┘ │                  │
└──────────┴────────────────────────────────────────────┴──────────────────┘
```

Modality switch is a `SegmentedControl` over `image`, `video`, `audio` — three mutually exclusive
choices in one control is exactly what a segmented control is for, and it is a `radiogroup`, so
arrow keys move the selection and the whole control is one tab stop.

### 13.3 Composition

- **Parameters** live in the inspector, not the composer, because they differ per modality and
  the composer must stay identical across the product (§18). `Field` + `Select` for size and
  aspect, `Slider` for steps and guidance with `formatValue`, `Input` for seed with a
  "Randomise" `IconButton` as its `adornment`.
- **Queue**: one row per `GenerationJob` with status `queued` / `running` / `completed` /
  `failed` / `cancelled`. A `running` job shows `Progress` bound to `GenerationJob.progress`
  with a real `label` ("Generating image, 40%"); a `queued` job shows
  `Progress indeterminate` — the queue position is known but the wait is not.
- **Results**: a grid of `Card elevation={1} padded={false}` holding the asset. Images render at
  their intrinsic ratio inside a `--radius-lg` (10px) clip. Video gets a poster frame and a play
  control. Audio gets a waveform (screen-local canvas) and a play control; use
  `color.accent` from `tokens.ts` for the canvas stroke rather than a literal, so the waveform
  follows the theme.
- Every result carries its `modelId`, `providerId` and `cost` at `.mrd-caption` beneath it.
  A generated asset with no provenance is not auditable.

### 13.4 States

**Empty (nothing generated):** `EmptyState size="md"` per modality — "No images yet" /
"Describe what you want. Meridian routes to an image model that can do it.", action "Generate".

**Loading (job running):** the queue row's `Progress` and a `Skeleton variant="block"` placeholder
in the results grid at the output's aspect ratio, so nothing reflows when the asset lands. This
is the clearest case for matching the skeleton to the real shape.

**Error (generation failed):** the queue row goes to `StatusChip status="error"` with
`GenerationJob.error` beneath it, and two actions: "Retry" and "Retry on another model". The
failed job stays in the queue until dismissed — a job that vanishes on failure takes its error
message with it.

**Error (asset failed to load):** the `Card` shows a region `EmptyState size="sm"` with a
"Reload" action. Do not fall back to a broken-image glyph.

### 13.5 Keyboard

| Shortcut | Action |
| --- | --- |
| `mod+enter` | Generate |
| `mod+1` / `mod+2` / `mod+3` | Image / Video / Audio — only when the generations screen has focus |
| `←` / `→` | Move within the results grid |
| `space` | Play / pause the focused video or audio result |
| `mod+s` | Save the focused asset |
| `mod+.` | Cancel the running job |

### 13.6 Responsive

- ≥1600: four results per row.
- 1200–1599: three.
- 900–1199: two; parameters move to a right sheet opened by a toolbar control.
- <900: one per row; the segmented control goes `fullWidth`; parameters become a
  `Sheet side="bottom"`; the queue collapses to a single row for the active job with a count.

---

## 14. Usage

### 14.1 Purpose

Where the money and the time went, sliced by whatever the operator needs to answer for.

### 14.2 Layout

```
┌──────────┬────────────────────────────────────────────┬──────────────────┐
│ Sidebar  │ ┌────────────────────────────────────────┐ │ Inspector        │
│          │ │ [24h│7d│30d│Custom]        [Export ▾]  │ │                  │
│          │ ├────────────────────────────────────────┤ │ Selected row     │
│          │ │ $18.40      1.2M tok    4,180    1.9%  │ │ ──────────       │
│          │ │ spend       tokens      calls    errors│ │ request id  ⧉    │
│          │ ├────────────────────────────────────────┤ │ user             │
│          │ │  spend over time (screen-local chart)  │ │ workspace        │
│          │ ├────────────────────────────────────────┤ │ task             │
│          │ │ Provider │ Model │ User │ Workspace    │ │ prompt tokens    │
│          │ ├────────────────────────────────────────┤ │ completion tok   │
│          │ │ MODEL       CALLS   TOK    COST   ERR  │ │ latency / ttft   │
│          │ │ claude-…    1,204  480k  $9.10  0.4%   │ │ fallbacks   2    │
│          │ └────────────────────────────────────────┘ │                  │
└──────────┴────────────────────────────────────────────┴──────────────────┘
```

### 14.3 Composition

- Range: `SegmentedControl` with 24h / 7d / 30d / Custom. Custom opens a `Popover role="dialog"`
  holding two date `Input`s and an Apply button.
- Summary figures: four `Card elevation={0}` tiles. Every figure carries `.mrd-numeric`, because
  these update live and a proportional figure would shift the tile's neighbours as digits change.
  The label sits under the value at `.mrd-caption`, and the value uses `.mrd-title` (21px) — not
  `.mrd-display` (30px). Display type belongs to a page that has one thing to say; a four-tile
  row of 30px numbers is a dashboard shouting.
- The chart is screen-local. It must take its colours from `tokens.ts` (`color.accent`,
  `color.separator`, `color.textTertiary`) rather than literals, so it follows the theme, the
  high-contrast media query and any future palette change. Axis labels use `.mrd-caption`.
- Breakdown: `Tabs variant="underline"` over Provider / Model / User / Workspace, each a `Table`
  over aggregated `UsageRecord`s with sortable numeric columns, `align: 'end'` on all of them.
- Selecting a row fills the inspector with the underlying record: `KeyValue` with `copy` on the
  request id, `numeric` on every figure, and the `fallbackCount` linking to the fallback detail.

### 14.4 States

**Empty (no usage in range):** `EmptyState size="sm" live`, "No usage in this range" / "Try a
wider range, or clear the filters.", action "Last 30 days". The `live` matters — the range
control changed the result, and the change must be announced.

**Empty (no usage ever):** `EmptyState size="md"`, "Nothing has run yet" / "Usage appears here
after the first request.", action "Start a chat".

**Loading:** tiles show `Skeleton variant="line" width={90} height={27}` at the title's line
height so the tile does not resize; the chart shows one `Skeleton variant="block"` at the chart's
height; tables use `Table loading`.

**Error:** region `EmptyState` per failed region. A failed chart must not take the tables with
it — they are separate queries and should fail separately.

### 14.5 Keyboard

`←`/`→` move the range segments and the breakdown tabs. `mod+f` filters the active table.
`mod+shift+e` opens the export menu. `↑`/`↓` and `enter` work the table as usual.

### 14.6 Responsive

- ≥1200: four tiles across, chart full width, inspector in flow.
- 900–1199: four tiles across, inspector as a right sheet.
- 640–899: tiles two-by-two; the chart keeps full width but drops to half height; the breakdown
  table drops the error column.
- <640: tiles stack into a single column of `FormRow`-shaped lines (label left, figure right);
  the chart is hidden — an unreadable chart is worse than an honest omission — and replaced by a
  "View chart" `Button variant="tertiary"` opening a `Sheet side="bottom"`.

---

## 15. Settings

### 15.1 Purpose

A sidebar-and-detail settings application inside the app. Everything the user can change about
how Meridian behaves for them, and nothing that belongs to the whole gateway (that is Admin).

### 15.2 Layout

```
┌────────────────────────────────────────────────────────────────────┐
│ Settings                                                    [×]    │
├──────────────────┬─────────────────────────────────────────────────┤
│ General          │  Routing                                        │
│ Appearance       │  ┌───────────────────────────────────────────┐  │
│ Routing        ✓ │  │ Default mode              [AUTO       ▾]  │  │
│ Privacy          │  ├───────────────────────────────────────────┤  │
│ Providers        │  │ Preferred pool            [coding     ▾]  │  │
│ Keyboard         │  ├───────────────────────────────────────────┤  │
│ Workspaces       │  │ Allow paid requests            [ ●——— ]   │  │
│ Advanced         │  │ Spend real money on requests              │  │
│                  │  ├───────────────────────────────────────────┤  │
│ 216px            │  │ Max cost per task         [$0.50      ]   │  │
│                  │  └───────────────────────────────────────────┘  │
│                  │  Changes apply to new requests only.            │
└──────────────────┴─────────────────────────────────────────────────┘
```

### 15.3 Composition

Settings is a `Dialog size="lg"` (680px) opened by `mod+,`, or a full screen on a dedicated
route. Its left column is a `List selectable size="lg"` — not a `Sidebar`, because the shell
already owns one `<nav>` and a second navigation landmark inside a modal competes with it.

Each category is a `PanelBody` of `Fieldset`s of `FormRow`s. `Fieldset` is a real `<fieldset>`
with a `<legend>`, so the group's title is announced as its name, and its `footnote` carries the
explanatory sentence that desktop settings put under a group. A setting whose detail is long
enough to bury the row uses `DisclosureRow`, whose panel is `hidden` while closed so its controls
leave the tab order along with the pixels.

Categories and their contents:

| Category | Contents |
| --- | --- |
| **General** | Startup screen (`Select`), reopen last workspace (`Switch`), telemetry (`Switch`, default off, with a `footnote` saying exactly what is sent) |
| **Appearance** | Theme (`RadioGroup orientation="horizontal"`: Light / Dark / System — writes `data-theme` or removes it), Reduce motion (`Switch` — writes `data-reduce-motion`, which collapses every duration token to 1ms), Density note explaining that heights are fixed by token and not user-adjustable |
| **Routing** | Default `RoutingMode` (`Select` over all fifteen modes, grouped: the six plain-language modes first, then the explicit policies), preferred pool, `allowPaid` (`Switch`), `maxCostPerTask` (`Input` with a `$` adornment), preferred models and providers (reorderable `List`) |
| **Privacy** | `PrivacyMode` (`RadioGroup`: `STRICT_LOCAL`, `TRUSTED_ONLY`, `FREE_PROVIDERS`, `ANY_PROVIDER`), each `Radio` carrying a `description` that says what it permits. Redaction of prompts in logs (`Switch`) |
| **Providers** | Per-provider enable `Switch`es and the user-scoped credential list (§11.3 filtered to `scope === 'user'`) |
| **Keyboard** | Every shortcut as a `FormRow` with `<Kbd shortcut="…" />` on the right. Read-only in v1; the row is present so the reference lives with the settings rather than in a separate help window |
| **Workspaces** | Default privacy mode and default routing mode per workspace, workspace root path (read-only, with `copy`) |
| **Advanced** | Gateway URL, request timeout, log level (`Select`), "Reset layout" (clears stored `SplitPane` fractions and sidebar collapse), "Clear local cache" (destructive, confirmed) |

Settings apply immediately on change and persist optimistically — a settings screen with a Save
button makes the user wonder whether the previous panel saved. The two exceptions are the
gateway URL and anything under Advanced that reconnects, which use an explicit
`Button variant="primary"` in the dialog footer.

### 15.4 States

**Empty:** never. Every category has content; a category with nothing configurable would not be
a category.

**Loading:** the category list renders immediately (it is a constant); the detail pane shows
`Skeleton variant="text" lines={4}` per `Fieldset`.

**Error (a setting failed to persist):** the control reverts to its stored value, and a
`toast({ variant: 'error' })` names the setting and offers "Retry". The revert must be visible —
a switch that silently stays on while the server has it off is the worst possible outcome.

### 15.5 Keyboard

`mod+,` opens; `escape` closes; `↑`/`↓` move the category list; `tab` moves into the detail
pane; `mod+f` filters settings by name across all categories, replacing the detail pane with a
flat result list until cleared.

### 15.6 Responsive

- ≥900: `Dialog size="lg"`, two columns.
- 640–899: `Sheet side="bottom"`; the category list becomes a `Select` at the top of the detail
  pane.
- <640: same, and `FormRow` stacks its label above its control (`align="start"`).

---

## 16. Admin

### 16.1 Purpose

Everything that belongs to the gateway rather than to a user. Visible only to `role === 'admin'`.

### 16.2 Layout

```
┌──────────┬────────────────────────────────────────────┬──────────────────┐
│ Sidebar  │ ┌────────────────────────────────────────┐ │ Inspector        │
│ Admin    │ │ Users │ Audit │ System │ Maintenance   │ │                  │
│ ● Users  │ ├────────────────────────────────────────┤ │ Selected user    │
│   Audit  │ │ NAME        EMAIL          ROLE  SEEN  │ │ ──────────       │
│   System │ │ ─────────────────────────────────────  │ │ role   [admin ▾] │
│   Maint. │ │ ◐ Ada L.    ada@…          admin  now  │ │ created          │
│          │ │ ◐ Bo K.     bo@…           member 2h   │ │ last seen        │
│          │ │ ◐ Cy R.     cy@…           viewer 3d   │ │ 30d spend        │
│          │ └────────────────────────────────────────┘ │ [Reset] [Remove] │
└──────────┴────────────────────────────────────────────┴──────────────────┘
```

### 16.3 Composition

- **Users** — `Table` over `User`. `Avatar size="sm" name={user.name} tint="auto"` in the name
  cell; `tint="auto"` derives a stable colour from the name so the same person keeps the same
  colour in every view. Role renders as a `Badge`: `admin` accent, `member` neutral, `viewer`
  neutral. Changing a role is a `Select` in the inspector, confirmed by a `Dialog` when
  promoting to admin.
- **Audit** — `Table` over `AuditLogEntry`, columns At, Actor, Action, Target, IP. The `details`
  object opens in a `Popover role="dialog"` as a `KeyValue` with `copy` on each value. Details
  are persisted with secrets already redacted; the UI must never imply it is doing that
  redaction itself, and must never offer a "show unredacted" affordance.
- **System** — `KeyValue` of version, uptime, database size, queue depth, worker count; plus
  `Meter`s for disk and memory with `threshold` at 85%.
- **Maintenance** — destructive operations, each behind a `Dialog dismissible={false}`: re-run
  discovery across all providers, rebuild the model index, vacuum the database, rotate the
  encryption key, purge usage older than N days. Each shows what it will affect **before** the
  confirm button becomes enabled — a confirmation you can dismiss without reading is not a
  confirmation.

### 16.4 States

**Empty (single-user gateway):** the Users table shows one row. No empty state — one user is a
correct answer. The Audit tab on a fresh install shows `EmptyState size="sm"`, "No activity
yet" / "Actions taken on this gateway will be recorded here."

**Loading:** `Table loading` per tab, `TabPanel lazy` so the audit query does not run until the
tab is opened.

**Error (not authorised):** the whole screen is replaced by an `EmptyState size="md"`, "Admin
access required" / "Ask a gateway administrator for the admin role.", with no retry action —
retrying will not help, and an action that cannot succeed is a lie. The Admin item is also
removed from the sidebar for non-admins; the screen-level check exists because a URL can be
typed.

**Error (operation failed):** session toast with the operation named and a "View log" action
opening the drawer.

### 16.5 Keyboard

`←`/`→` tabs; `↑`/`↓` rows; `enter` opens the inspector; `mod+f` filters the active table.
Maintenance actions have no shortcuts, deliberately.

### 16.6 Responsive

- ≥1200: table + inspector.
- 900–1199: inspector as a right sheet.
- <900: tables become `List size="lg"`; the audit `details` popover becomes a bottom sheet;
  Maintenance stacks its cards one per row.

---

## 17. Onboarding

### 17.1 Purpose

Get a fresh install from nothing to a first successful request. It runs before the shell has any
data, so it is the one screen that owns the whole window.

### 17.2 Layout

```
┌────────────────────────────────────────────────────────────────────┐
│                                                                    │
│                          Meridian                                  │
│              Set up your gateway in three steps.                   │
│                                                                    │
│   ┌────────────────────────────────────────────────────────────┐   │
│   │ ● Find providers          ✓  4 found in your environment   │   │
│   │ │                                                          │   │
│   │ ● Add a credential        ▸  openrouter, anthropic         │   │
│   │ │                                                          │   │
│   │ ○ Send a test request     —                                │   │
│   └────────────────────────────────────────────────────────────┘   │
│                                                                    │
│                     [Skip setup]      [Continue]                   │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

### 17.3 Composition

A single centred `Panel elevation={2}` at `max-width: calc(var(--inspector-width) * 2)` (680px,
the same measure as `Dialog size="lg"`), on the app background. This is the one screen where
`.mrd-display` (30px) is correct: it has exactly one thing to say.

The three steps are a `Timeline` with `TimelineStep`s driven by real state, not by a wizard's
page counter:

1. **Find providers.** On mount, the gateway scans `ProviderDescriptor.envKeys`. The step's
   `details` list what was found as a `List size="sm"` with a `StatusChip` each. If nothing is
   found, the step completes anyway with `status="completed"` and the meta "None found — add one
   manually"; a scan that found nothing did not fail.
2. **Add a credential.** `details` hold the credential dialog's fields inline (§11.3). Skippable
   if step 1 found a local provider (`ProviderDescriptor.local === true`) — a local model needs
   no key, and forcing a key on a local-only install is the fastest way to lose that user.
3. **Send a test request.** A fixed prompt against the cheapest available route. While running,
   `status="running"` and a `Progress indeterminate`. On success, `status="completed"` with the
   model, latency and cost in `meta`. On failure, `status="failed"` with the error and a "Try
   another provider" action.

The footer holds `Button variant="tertiary"` ("Skip setup") and `Button variant="primary"
size="lg"` ("Continue"), which is disabled until at least one step has completed and carries a
`Tooltip` saying why while it is.

### 17.4 States

**Empty:** onboarding *is* the empty state of the product; it has none of its own.

**Loading (scanning):** step 1 is `status="running"` with a `Progress indeterminate
label="Scanning environment"`. The other two steps stay `pending` — do not show three
simultaneous spinners for work that is sequential.

**Error (gateway unreachable during setup):** replace the panel body with an `EmptyState
size="md"`, "Cannot reach the gateway" / "Meridian is running, but the gateway is not
responding.", actions "Retry" and "Open setup guide". Keep the header — the user still needs to
know which product is failing.

**Skipped:** "Skip setup" goes straight to Home, which then shows its own empty state with a
"Finish setup" action. Onboarding is resumable, never a one-shot.

### 17.5 Keyboard

`tab` through steps in order; `enter` advances; `escape` on the credential step collapses it
without leaving onboarding. `mod+enter` runs the test request from anywhere on the screen.

### 17.6 Responsive

The panel is `max-width: 680px` with `--space-6` (24px) of margin. Below 640px it fills the
width, the display type drops to `.mrd-title` (21px), and the two footer buttons go `fullWidth`
and stack, primary first.

---

## 18. The composer

The composer is the product's central interaction. It appears on Home, Chat, Tasks, Workspace
and Generations, and it must be **the same object every time**: same anatomy, same shortcuts,
same submit semantics. A composer that behaves differently on two screens teaches the user to
stop trusting it.

### 18.1 Anatomy

```
┌────────────────────────────────────────────────────────────────────┐
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                                                              │  │
│  │  prompt — TextArea, rows={3}, min-height 68px                │  │
│  │                                                              │  │
│  └──────────────────────────────────────────────────────────────┘  │
│  ┌── attachments (only when present) ─────────────────────────────┐ │
│  │  ▣ schema.sql  ×      ▣ screenshot.png  ×                     │ │
│  └────────────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ [AUTO ▾] [pool ▾] [◎ model] [＋]        1,204 tok ~$0.004  [Send ⌘↵] │
│  └────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
   Panel elevation 1 · radius --radius-xl (12px) · body padding --space-3 (12px)
   option row height 34px (--control-height-lg) · gap --space-2 (8px)
```

### 18.2 Composition

```tsx
import { Panel, PanelBody, Stack, Button, IconButton, TextArea, Kbd, Badge } from '@meridian/ui';

export function Composer({ value, onChange, onSubmit, mode, onModeChange, busy }: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  return (
    <Panel elevation={1}>
      <PanelBody padded scroll={false}>
        <TextArea
          ref={ref}
          rows={3}
          fullWidth
          resize="vertical"
          value={value}
          placeholder="Describe what you want. ⌘↵ to send."
          aria-label="Prompt"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <Stack direction="row" gap={2} align="center" style={{ marginTop: 'var(--space-2)' }}>
          <ModeMenu mode={mode} onChange={onModeChange} />
          <PoolMenu />
          <ModelPin />
          <IconButton label="Attach files" icon={<PlusGlyph />} onClick={attach} />
          <span className="mrd-spacer" />
          <span className="mrd-caption mrd-numeric">{tokens} tok · ~{cost}</span>
          <Button
            variant="primary"
            onClick={onSubmit}
            loading={busy}
            disabled={value.trim() === ''}
            trailingIcon={<Kbd shortcut="mod+enter" size="sm" />}
          >
            Send
          </Button>
        </Stack>
      </PanelBody>
    </Panel>
  );
}
```

Notes on the real API used above:

- `TextArea` has a `min-height` of `calc(var(--control-height-lg) * 2)` = 68px and
  `resize: vertical` by default, so the user can drag it taller. Screen-local auto-grow caps at
  40% of the main column's height and then scrolls; do not pass `resize="none"` — taking away
  the drag handle to make room for auto-grow is a net loss.
- `Button` renders `trailingIcon` only when not `loading`, so the `⌘↵` cap disappears while the
  request is in flight and the button keeps its width. `loading` also sets `aria-busy` and
  disables the button.
- `.mrd-spacer` is a `base.css` utility (`flex: 1 1 auto; min-width: 0`) — use it rather than
  `marginLeft: auto`, so the row still shrinks correctly on a narrow viewport.
- The token/cost readout uses `.mrd-caption` and `.mrd-numeric`. Tabular figures are not
  optional here: the number changes on every keystroke, and proportional digits would make the
  Send button jitter.

### 18.3 Submit semantics

| Key | Behaviour |
| --- | --- |
| `mod+enter` | Submit. Works from anywhere inside the composer, including the option row |
| `enter` | Newline. **Always.** Never submit on bare Enter — a multi-line prompt is the normal case, and losing one to a stray Enter is unforgivable |
| `shift+enter` | Newline (the habit some users bring; it must not do anything surprising) |
| `escape` | Blur the composer and return focus to the screen's primary region. It must not clear the draft |
| `↑` in an empty composer | Load the previous submission for editing |
| `mod+.` | Stop a streaming response |

Submit is disabled while the trimmed value is empty. It is **not** disabled while a response is
streaming — that control becomes "Stop" (`variant="secondary"`), because interrupting is a more
common need than queueing.

### 18.4 The option row

Four controls, in this order, and no more. Each is a `Button variant="tertiary" size="md"` or an
`IconButton`, and each opens a `Menu`.

1. **Mode.** The current `RoutingMode`. The `Menu` shows the six plain-language modes
   (`AUTO`, `BEST`, `FAST`, `CHEAP`, `FREE`, `LOCAL`) in one `MenuGroup label="Mode"`, then the
   explicit policies (`FREE_FIRST`, `CHEAP_FIRST`, `QUALITY_FIRST`, `FASTEST`, `LOCAL_FIRST`,
   `USER_FIRST`, `ADMIN_FIRST`, `BALANCED`, `CUSTOM`) in a second group behind a
   `MenuSeparator`. `checked` marks the current one, which makes the item a
   `menuitemcheckbox`. `shortcut="mod+shift+m"` on the trigger.
2. **Pool.** The `InferencePool` to draw from, or "Any pool". Disabled with an explanatory
   `Tooltip` when a specific model is pinned.
3. **Model pin.** "Auto" by default. Choosing a model sets `AIRequest.model` and turns the
   control into a `Badge variant="accent"` with an `×`. A pinned model overrides the mode, and
   the control must say so in its `Tooltip` — a user who pinned a model and then wonders why
   `CHEAP` did nothing has been failed by the interface, not by the router.
4. **Attach.** Files, images, or a workspace path. Attachments render as a wrapping row of
   `Badge variant="neutral"` chips with a remove `IconButton size="sm"` each, above the option
   row and only when there is at least one.

### 18.5 Guards

The composer is the last place a mistake is cheap, so it carries three guards.

- **Budget.** When the estimated cost exceeds `UserPreferences.maxCostPerTask`, the Send button
  stays enabled but a `Badge variant="warning"` appears in the option row reading "Over your
  per-task cap", and submitting opens a `Dialog size="sm"` asking to proceed once or raise the
  cap. Never block silently.
- **Paid.** When `allowPaid` is false and every candidate route costs money, Send is disabled
  with a `Tooltip`: "Paid requests are off. Switch to FREE, or enable paid requests in
  Settings." The tooltip names the fix, and the fix is one click away.
- **Privacy.** When the workspace's `PrivacyMode` is `STRICT_LOCAL` and no local provider is
  healthy, Send is disabled with a `Tooltip` naming the constraint. A privacy mode that silently
  degrades to a remote provider is a security bug, not a UX compromise.

### 18.6 States

| State | Presentation |
| --- | --- |
| Empty | Placeholder text, Send disabled, cost readout absent |
| Typing | Live token count and cost estimate, both `.mrd-numeric` |
| Submitting | `Button loading` — spinner, width held, `aria-busy` |
| Streaming | Send becomes "Stop" `variant="secondary"`; the `TextArea` stays editable so the next prompt can be drafted |
| Error | The failure belongs to the turn, not the composer. The composer restores the submitted text so nothing is lost, and a session toast carries the reason |
| Disabled (offline) | Whole `Panel` at 42% opacity, Send disabled with a `Tooltip` naming the gateway state |

### 18.7 Responsive

- ≥900: as drawn.
- 640–899: cost readout drops to the token count alone.
- <640: the four option controls collapse into a single `IconButton` opening one `Menu` with
  four `MenuGroup`s; Send keeps its label and loses the `Kbd` cap, since there is no physical
  keyboard to hint at.

---

## 19. The command palette

### 19.1 Purpose

Every action in the product, reachable by name, in one keystroke.

### 19.2 Construction

The palette is a `Dialog size="md"` (500px) opened with `mod+k`. It is a `Dialog` because it
needs the focus trap, the scroll lock, the Escape chain and correct stacking above whatever it
was opened over — all of which the shared modal shell already provides. `title` is "Command
palette", which is its accessible name and its visible header.

```tsx
<Dialog open={open} onOpenChange={setOpen} title="Command palette" size="md" initialFocus={queryRef}>
  <SearchField
    ref={queryRef}
    value={query}
    onValueChange={setQuery}
    placeholder="Type a command"
    fullWidth
    onKeyDown={forwardArrowsToList}
  />
  <List selectable value={active} onSelect={run} label="Commands" size="lg">
    {results.map((c) => (
      <ListRow key={c.id} value={c.id} icon={c.icon} secondary={c.group}
               trailing={c.shortcut ? <Kbd shortcut={c.shortcut} size="sm" /> : null}>
        {c.label}
      </ListRow>
    ))}
  </List>
</Dialog>
```

`SearchField` handles Escape itself while it has content — clearing the query rather than
closing the palette — and only lets Escape through to the dialog once the field is empty. That
two-stage Escape is the behaviour a palette wants and it comes for free.

`--z-palette` (80) sits above `--z-modal` (70) in `tokens.css` and is not used by any primitive.
It is reserved for a future screen-local palette portal that must paint above a modal without
being one. Until such a thing exists, do not set it by hand: `useOverlayLayer` already gives each
new layer one step above the current top of the stack, so a palette opened over a dialog stacks
correctly today.

### 19.3 Behaviour

- Results are grouped by `secondary`, ranked by: exact prefix match on the label, then substring,
  then recency of use. Recency is per user and persisted.
- The first result is pre-selected. `↑`/`↓` move (provided by `List`), `enter` runs, `escape`
  clears then closes.
- A command that needs an argument (open workspace, switch model, jump to task) pushes a second
  stage into the same dialog: the query field's placeholder changes, a `Badge` naming the
  pending command appears before it, and `backspace` on an empty query pops back one stage.
- Unavailable commands are shown, disabled, with the reason as `secondary` — "Requires admin",
  "No workspace open". Hiding a command the user is looking for is worse than showing them why
  it is unavailable.
- Destructive commands are prefixed with their object and confirmed after selection, never
  executed straight from the palette.

### 19.4 The command list

| Group | Command | Shortcut |
| --- | --- | --- |
| **Navigate** | Go to Home | `mod+1` |
| | Go to Workspace | `mod+2` |
| | Go to Chat | `mod+3` |
| | Go to Tasks | `mod+4` |
| | Go to Agents | `mod+5` |
| | Go to Models | `mod+6` |
| | Go to Providers | `mod+7` |
| | Go to Pools | `mod+8` |
| | Go to Usage | `mod+9` |
| | Go to Generations | — |
| | Go to Admin | — |
| | Open Settings | `mod+,` |
| | Keyboard shortcuts | `mod+/` |
| **View** | Toggle sidebar | `mod+b` |
| | Toggle inspector | `mod+alt+i` |
| | Toggle drawer | `mod+j` |
| | Focus file tree | `mod+shift+e` |
| | Focus composer | `mod+shift+i` |
| | Reset layout | — |
| | Theme: Light / Dark / System | — |
| | Toggle reduce motion | — |
| **Session** | New chat | `mod+n` |
| | New task | `mod+shift+n` |
| | Retry last turn | `mod+shift+r` |
| | Stop generation | `mod+.` |
| | Explain last route | `mod+shift+y` |
| | Copy last response | — |
| | Export conversation | — |
| **Routing** | Set mode: AUTO / BEST / FAST / CHEAP / FREE / LOCAL | `mod+shift+m` |
| | Set policy: FREE_FIRST / CHEAP_FIRST / QUALITY_FIRST / FASTEST / LOCAL_FIRST / USER_FIRST / ADMIN_FIRST / BALANCED / CUSTOM | — |
| | Pin model… | — |
| | Clear pinned model | — |
| | Use pool… | — |
| | Set privacy: STRICT_LOCAL / TRUSTED_ONLY / FREE_PROVIDERS / ANY_PROVIDER | — |
| | Toggle allow paid requests | — |
| **Workspace** | Open workspace… | `mod+o` |
| | Quick open file… | `mod+p` |
| | Search in workspace… | `mod+shift+f` |
| | Save file | `mod+s` |
| | Close tab | `mod+w` |
| | Split editor | `mod+\` |
| | Open terminal | `mod+j` |
| | Clone repository… | — |
| **Changes** | Review pending changes | `mod+shift+d` |
| | Accept hunk | `a` (in review) |
| | Reject hunk | `r` (in review) |
| | Accept all in file | — |
| | Reject all in file | — |
| | Apply accepted changes | `mod+enter` (in review) |
| | Undo last review action | `mod+z` (in review) |
| **Models** | Search models… | — |
| | Compare models… | `mod+shift+c` |
| | Run discovery on provider… | — |
| | Test provider… | `mod+shift+t` |
| **Pools** | New pool | — |
| | Edit pool… | — |
| | New reservation… | — |
| **Generations** | Generate image | — |
| | Generate video | — |
| | Generate speech | — |
| | Transcribe audio… | — |
| **Admin** | Manage users | — |
| | View audit log | — |
| | Run discovery on all providers | — |
| | Rebuild model index | — |
| | Purge usage older than… | — |
| **Help** | Open documentation | — |
| | Copy diagnostics | — |
| | About Meridian | — |

Shortcuts in this table are the single source for both the palette's `Kbd` caps and the menus'
`shortcut` props. A shortcut that appears in two places with two values is a bug in this table,
not in the code.

### 19.5 States

**Empty (no query):** the ten most recently used commands, `secondary` reading "Recent". On a
fresh install, ten curated starting commands instead.

**Empty (no matches):** `EmptyState size="sm" live` inside the dialog body — "No command matches
'{query}'" with a "Clear" action.

**Loading:** commands are local and never load. Argument stages that need server data (workspace
list, model list) show three `Skeleton variant="text"` rows in the list while the fetch runs;
the query field stays live.

**Error:** an argument stage that fails to load shows a region `EmptyState size="sm"` with the
reason and a retry action. The palette does not close.

### 19.6 Responsive

`Dialog size="md"` (500px) at every width, which at <640px means it fills the viewport minus its
margins. Below 640px the `Kbd` caps are hidden — there is no keyboard to hint at — and the list
uses `size="lg"` rows for touch.

---

## 20. The routing-explanation panel

### 20.1 Purpose

Answer "why this model?" completely enough that the answer can be argued with. This panel is the
single most important trust surface in the product: a router nobody can audit is a router nobody
believes.

### 20.2 Source

`RoutingReason` from `@meridian/shared`:

- `summary` — one human sentence.
- `criteria` — `{ label, met, detail? }[]`, the checklist.
- `considered` — ranked `RoutingCandidate[]`, each with `modelId`, `providerId`, `score`,
  `factors` (a per-factor contribution map), `estimatedCost`, `estimatedLatencyMs`, `free`.
- `rejected` — `{ modelId, reason }[]`, dropped before scoring.
- `mode` — the `RoutingMode` in force.

### 20.3 Layout

```
┌────────────────────────────────────────────┐
│ Why this model?                     [×]    │
├────────────────────────────────────────────┤
│  Badge: QUALITY_FIRST                      │
│                                            │
│  Best current coding score on a healthy    │
│  free provider.                            │
│                                            │
│  ✓ Supports tools            required      │
│  ✓ Context ≥ 32k             128k          │
│  ✓ Provider healthy          610 ms        │
│  ✗ Cheapest available        $0.002 more   │
│                                            │
│  Considered                                │
│  ── anthropic:claude-…  92  $0.004  1.2s ●│
│     openai:gpt-…        88  $0.003  0.9s   │
│     ollama:llama-…      61  free    0.4s   │
│                                            │
│  ▸ 14 candidates were not considered       │
├────────────────────────────────────────────┤
│  [Use a different model]  [Retry]          │
└────────────────────────────────────────────┘
```

### 20.4 Composition

- **Mode** — a `Badge variant="accent"` at the top. The mode explains the whole panel; it goes
  first.
- **Summary** — `.mrd-body-lg` (14px / 21px). One sentence, not a paragraph.
- **Criteria** — a `List size="sm"` with one `ListRow` per criterion. `icon` is a check for
  `met`, a cross for not met — **shape, not colour**, and the `detail` goes in `trailing` at
  `.mrd-caption`. An unmet criterion is not an error: the router traded it away deliberately, and
  the panel exists to show that trade.
- **Considered** — a `Table` over `RoutingCandidate` with columns Model, Score, Cost, Latency,
  and a `StatusChip size="sm" hideLabel` marking the winner. `align: 'end'` on the three numeric
  columns, `.mrd-numeric` in every cell. `free` candidates render "free" rather than "$0.00" —
  free and zero-cost are different claims.
- **Factors** — expanding a candidate row reveals its `factors` map as one `Meter size="sm"` per
  factor, `showLabel`, with `valueText` giving the raw contribution. This is where a routing
  argument is actually won or lost, so it must be reachable, and it must be one click deep rather
  than always on screen.
- **Rejected** — a `DisclosureRow` labelled "{n} candidates were not considered", revealing a
  `List size="sm"` of `modelId` with the rule that dropped it as `secondary`. Closed by default;
  its panel is `hidden` while closed, so fourteen rows do not sit in the tab order.
- **Actions** — a `Panel` footer with `Button variant="secondary"` ("Use a different model",
  opening the model picker with the considered set pre-filtered) and
  `Button variant="tertiary"` ("Retry").

### 20.5 Placement

- ≥1200px: in the `Inspector`, replacing its contents while open. The turn that owns it stays
  selected in the main column.
- 900–1199px: `Sheet side="right"`.
- <900px: `Sheet side="bottom"`.

Never a `Tooltip` and never a hover popover. This is content to be read, compared and copied;
it must survive the pointer leaving.

### 20.6 States

**Empty (no reason recorded):** `EmptyState size="sm"` — "No routing record" / "This response
was produced before routing explanations were recorded." No action.

**Loading:** `Skeleton variant="text" lines={2}` for the summary, four `Skeleton` rows for the
criteria, `Table loading skeletonRows={3}` for the candidates.

**Error:** region `EmptyState size="sm"` with a retry action. The turn stays intact.

### 20.7 Keyboard

`mod+shift+y` opens it for the most recent turn. `escape` closes it (the sheet form gets this
from the modal shell; the inspector form must handle it locally). `↑`/`↓` move the candidate
table; `space` expands a candidate's factors.

---

## 21. The fallback notice

### 21.1 Purpose

The router silently retrying is a feature. The user not knowing it retried is a bug. A fallback
notice is how a `FallbackEvent` becomes visible without becoming alarming.

### 21.2 Source

`FallbackEvent`: `at`, `fromProvider`, `fromModel`, `toProvider`, `toModel`, `code` (a machine
code such as `rate_limited`), `message` (one user-facing sentence), `attempt`.

### 21.3 Presentation

An inline strip, not a toast, placed immediately above the metadata row of the turn or inside
the timeline step that fell back:

```
┌──────────────────────────────────────────────────────────────┐
│ ◐  Switched to openai:gpt-… — anthropic was rate limited.    │
│    attempt 2 of 3                                  ▸ Details │
└──────────────────────────────────────────────────────────────┘
```

- Background `--color-warning-subtle`, text `--color-warning`, hairline
  `inset 0 0 0 1px var(--color-warning-subtle)`, radius `--radius-md` (8px), padding
  `--space-2` (8px) `--space-3` (12px).
- The glyph is a `StatusChip size="sm" hideLabel` whose status is derived from `code`:
  `rate_limited → rate_limited`, an auth failure → `error`, a timeout or 5xx → `degraded`,
  anything unrecognised → `unknown`. The chip announces the canonical status name even when the
  visible label is hidden.
- The sentence is `FallbackEvent.message`. Do not compose your own from the code — the message
  is written to be read.
- `attempt` renders at `.mrd-caption` with `.mrd-numeric`.
- "Details" is a `DisclosureRow` revealing a `KeyValue` with `from`, `to`, `code`, `at` and a
  `copy` on the code, for pasting into an issue.

### 21.4 Rules

1. **Never silent.** Every `FallbackEvent` produces a notice on the turn or step it belongs to.
2. **Never a toast, except at the end.** Individual fallbacks are inline. Only an exhausted
   `fallbackChain` — the request finally failing — raises
   `toast({ variant: 'error', action: { label: 'Retry', … } })`.
3. **Collapse repeats.** Three fallbacks within one turn render as one strip reading "Switched
   twice before reaching openai:gpt-…" with all three in the Details disclosure. Three stacked
   strips is a wall.
4. **`toModel` may be null.** That is the chain running out. Render "No fallback available" at
   `--color-error` and skip the arrow, rather than printing "null".
5. **Status bar.** While a fallback is in flight, the status bar's centre slot shows
   `StatusChip status="busy"` with the target model. It reverts when the turn completes; it does
   not accumulate history.
6. **Persistence.** The notice stays in the transcript forever. It is part of what happened.

### 21.5 States

Loading is not applicable — a fallback notice only ever renders from a recorded event. If the
event is present but `message` is empty, render the code in a `Badge variant="warning"` and the
`from → to` pair; never render an empty strip, and never hide the fact that a switch occurred
because the copy is missing.

---

## 22. The diff review flow

### 22.1 Purpose

Agents propose changes; people accept them. Nothing is written to disk until it is accepted —
`FileChange.state` is `pending`, `accepted` or `rejected`, and the queue is the record.

### 22.2 Layout

```
┌───────────────┬──────────────────────────────────────────────────────┐
│ Changes  3    │ src/router/score.ts              [Unified│Split]     │
│ ───────────── ├──────────────────────────────────────────────────────┤
│ ● score.ts  M │  12 │       │ export function score(              │  │
│   +18 −4      │  13 │ ───── │-  const w = 1;                      │  │
│ ○ pool.ts   M │  13 │ +++++ │+  const w = weightFor(candidate);   │  │
│   +2  −2      │  14 │       │   return base * w;                  │  │
│ ○ types.ts  A │     │       │                                     │  │
│   +40         │  ┌──────────────────────────────────────────────┐   │
│               │  │ hunk 1 of 3            [Reject]  [Accept]    │   │
│               │  └──────────────────────────────────────────────┘   │
├───────────────┴──────────────────────────────────────────────────────┤
│ 2 accepted · 1 rejected · 3 pending          [Undo]  [Apply 2 files] │
└──────────────────────────────────────────────────────────────────────┘
```

At full width the review is a horizontal `SplitPane`: the file queue on the left
(`minSizes[0] = 0.15`), the diff on the right. In the workspace it opens in the drawer's Diffs
tab or as an editor tab; on the Tasks screen it opens as a `Dialog size="lg"`.

### 22.3 Colours

The diff palette is deliberately separate from success and error:

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--color-diff-add-bg` | `rgba(27, 138, 86, 0.11)` | `rgba(63, 188, 128, 0.15)` | added line background |
| `--color-diff-add-text` | `#12633c` | `#6fd6a1` | added line text |
| `--color-diff-del-bg` | `rgba(200, 50, 47, 0.1)` | `rgba(242, 99, 95, 0.14)` | deleted line background |
| `--color-diff-del-text` | `#97231f` | `#ff8a86` | deleted line text |
| `--color-diff-gutter` | `rgba(28, 27, 25, 0.04)` | `rgba(255, 255, 255, 0.04)` | line-number gutter |

They exist as their own tokens so that **a rejected hunk and a deletion never look like the same
thing**. Rejection is a review state and uses the neutral fills (`--color-fill-quiet`,
`--color-fill-selected`); deletion is content and uses the diff palette. Reuse
`--color-error-subtle` for a rejected hunk and the two become indistinguishable at a glance,
which is exactly the mistake this split prevents.

Diff text is `.mrd-code` (12.5px / 19px monospace) with the gutter in `.mrd-numeric`.

### 22.4 The three actions

Accept, reject and undo, at three scopes: hunk, file, and change set.

- **Hunk.** A joined `ButtonGroup` under each hunk, `Button size="sm"`: Reject then Accept
  (destructive-leaning action on the left, so the pointer does not travel over Accept to reach
  Reject). Joined, because the two read as one control: only the outer corners round, and the
  buttons share a 1px border.
- **File.** In the file row's `trailing` slot: "Accept all" / "Reject all"
  `Button variant="tertiary" size="sm"`, plus a `Badge` of the pending hunk count.
- **Change set.** The footer: `Button variant="tertiary"` ("Undo") and
  `Button variant="primary"` ("Apply {n} files"), where `n` counts files with at least one
  accepted hunk. Apply is disabled at zero with a `Tooltip` saying so.

```tsx
<ButtonGroup>
  <Button size="sm" onClick={() => reject(hunk.id)}>Reject</Button>
  <Button size="sm" variant="secondary" onClick={() => accept(hunk.id)}>Accept</Button>
</ButtonGroup>
```

### 22.5 Undo

Undo is the reason none of these actions confirm.

- Every accept and reject pushes onto a review-local undo stack and raises a
  `toast({ title: 'Hunk rejected', action: { label: 'Undo', onClick: undo } })`. The toast lasts
  6 seconds by default and pauses while the pointer or focus is on it, so the offer survives
  being read.
- `mod+z` undoes the last review action; the stack is unbounded within a review session.
- Undo works up to **Apply**. Apply writes to disk and clears the stack; after it, the offer
  changes from "Undo" to "Revert", which creates a new change set rather than rewinding one.
  Saying "undo" for two different operations is how a user loses work.

### 22.6 States

**Empty (no pending changes):** `EmptyState size="md"` — "No changes to review" / "Changes an
agent proposes appear here before anything is written." No action.

**Empty (all reviewed, none accepted):** `EmptyState size="sm"` — "Nothing accepted" /
"Every hunk was rejected. Apply is not available." with a "Reset review" action.

**Loading:** the file queue renders first (paths and counts arrive with the change set); the
diff pane shows `Skeleton variant="block"` at the pane height with
`label="Loading diff for src/router/score.ts"`.

**Error (diff failed to render):** region `EmptyState` inside the diff pane with "Open file
instead" as the action; the queue stays intact so the other files remain reviewable.

**Error (apply failed):** this is the important one. Apply is per-file, and a partial failure
must be reported per file: the files that were written go to `accepted` and show a check; the
files that failed return to `pending` and show `StatusChip status="error"` with the reason. One
session toast summarises: "2 of 3 files written". Never report a partial write as a success, and
never roll back files that succeeded.

**Conflict:** if a file changed on disk since the diff was produced, the file row shows
`Badge variant="warning"` reading "Out of date" and Apply for that file is disabled until the
diff is refreshed. Offer "Refresh diff" as the action.

### 22.7 Keyboard

| Key | Action |
| --- | --- |
| `n` / `p` | Next / previous hunk |
| `a` | Accept the focused hunk |
| `r` | Reject the focused hunk |
| `shift+a` / `shift+r` | Accept / reject the whole file |
| `mod+z` | Undo the last review action |
| `mod+enter` | Apply accepted changes |
| `↑` / `↓` | Move within the file queue (`List` roving) |
| `u` | Toggle unified / split |

Single-letter shortcuts are active only when focus is inside the review region and not inside a
text field. State that constraint in the shortcuts dialog; an `a` that accepts a hunk while the
user is typing a commit message is a bug waiting to happen.

### 22.8 Responsive

- ≥1200: queue + diff side by side, split view available.
- 900–1199: queue + diff side by side, unified view forced — a split diff needs roughly 120
  characters of width to be worth having.
- 640–899: queue becomes a `Select` above the diff; unified only; hunk actions move to a sticky
  footer.
- <640: review is read-only. Accept and reject remain, but Apply requires a wider viewport and
  says so — writing to a repository from a phone, from a screen too small to read the diff, is
  a decision the interface should not make easy.

---

## 23. The parallel-agent lane view

### 23.1 Purpose

`AgentTask.lane` groups tasks running at the same time on different parts of the work —
"frontend", "backend", "tests". This view shows all lanes at once, so contention and idleness
are visible.

### 23.2 Layout

```
┌──────────┬─────────────────────────────────────────────────────────┐
│ Sidebar  │  Lanes            [+ Lane]   3 running · 2 files conflict│
│          ├──────────────┬──────────────┬──────────────┬────────────┤
│          │ FRONTEND   2 │ BACKEND    1 │ TESTS      0 │ REVIEW   1 │
│          ├──────────────┼──────────────┼──────────────┼────────────┤
│          │ ┌──────────┐ │ ┌──────────┐ │              │ ┌────────┐ │
│          │ │ Nav bar  │ │ │ Pool API │ │  EmptyState  │ │ PR #12 │ │
│          │ │ ●●○○     │ │ │ ●●●○     │ │   size="sm"  │ │ ●○○    │ │
│          │ │ 1.4k tok │ │ │ 2.1k tok │ │              │ │ queued │ │
│          │ │ ⚠ 2 files│ │ │ ⚠ 2 files│ │              │ └────────┘ │
│          │ └──────────┘ │ └──────────┘ │              │            │
│          │ ┌──────────┐ │              │              │            │
│          │ │ Settings │ │              │              │            │
│          │ │ ●●●●  ✓  │ │              │              │            │
│          │ └──────────┘ │              │              │            │
├──────────┴──────────────┴──────────────┴──────────────┴────────────┤
│ 4 tasks · 3 running · $0.19 · 2 files contended                    │
└────────────────────────────────────────────────────────────────────┘
```

### 23.3 Composition

- Each lane is a `Panel elevation={0}` with a `PanelHeader variant="label"` — the small
  uppercase panel style, which is exactly what a column header for a region is — whose `title` is
  the lane name and whose `actions` slot holds the running count as a `Badge`.
- Lane bodies are `PanelBody scroll` holding one `Card elevation={0} onClick={...}` per task.
- A task card holds: the title, a compact step strip (one 8px dot per `TaskStep`, filled by
  `StepStatus`, using the same glyph vocabulary as `TimelineStep` so the two views agree), the
  token count with `.mrd-numeric`, and a `StatusChip size="sm"`.
- **Contention.** When two lanes have tasks touching the same path (`TaskStep.filesTouched`),
  both cards show a `Badge variant="warning"` with the count, and the status bar's right slot
  reports the total. Clicking the badge opens a `Popover role="dialog"` listing the contended
  paths and the lanes claiming them. Contention is the whole reason to run lanes in parallel and
  the whole risk of doing so; it must not be buried.
- Lanes are columns and do not resize independently. Four is the maximum shown; a fifth lane
  scrolls the row horizontally via `.mrd-scroll-x`, which keeps the shell from scrolling.

### 23.4 States

**Empty (no lanes):** the whole view shows `EmptyState size="md"` — "No parallel work" /
"Assign a lane when you start a task to run several in parallel.", action "New task".

**Empty (a lane with no tasks):** `EmptyState size="sm"` inside that lane's body — "Idle" /
"Nothing assigned to this lane." with a "Start task here" action. An idle lane is information,
not a gap.

**Loading:** each lane renders its header immediately (lane names are known) with two
`Skeleton variant="block" height={92}` cards beneath.

**Error (a task failed):** its card takes `StatusChip status="error"` and moves to the top of
its lane. The lane header's badge switches to `variant="error"`. Do not remove a failed task
from its lane; the lane is where the work was.

### 23.5 Keyboard

| Shortcut | Action |
| --- | --- |
| `←` / `→` | Move between lanes |
| `↑` / `↓` | Move between tasks within a lane |
| `enter` | Open the focused task (§8) |
| `mod+alt+←` / `mod+alt+→` | Move the focused task to the previous / next lane |
| `mod+.` | Stop the focused task |

Moving a task between lanes reassigns `AgentTask.lane` and raises an undo toast.

### 23.6 Responsive

- ≥1600: four lanes visible.
- 1200–1599: three lanes; the rest scroll horizontally.
- 900–1199: two lanes.
- <900: lanes become a `Tabs variant="pill"` row with the running count as each tab's `count`,
  and one lane's cards fill the column. Columns narrower than roughly 260px stop being readable,
  and a tab row is an honest way to say so.

---

## 24. Appendix

### 24.1 Complete shortcut reference

Rendered in the `mod+/` dialog, generated from this table. Written in `matchesShortcut` form and
displayed through `formatShortcut`.

| Scope | Shortcut | Action |
| --- | --- | --- |
| Global | `mod+k` | Command palette |
| Global | `mod+,` | Settings |
| Global | `mod+/` | Shortcut reference |
| Global | `mod+b` | Toggle sidebar |
| Global | `mod+alt+i` | Toggle inspector |
| Global | `mod+j` | Toggle drawer |
| Global | `mod+1`…`mod+9` | Jump to screen |
| Global | `escape` | Close the topmost dismissible layer |
| Global | `F6` / `shift+F6` | Next / previous shell region |
| Composer | `mod+enter` | Send |
| Composer | `enter` | Newline |
| Composer | `escape` | Blur, keeping the draft |
| Composer | `↑` (empty) | Previous submission |
| Composer | `mod+.` | Stop generation |
| Composer | `mod+shift+m` | Routing mode |
| Composer | `mod+shift+i` | Focus the composer |
| Chat | `mod+n` | New thread |
| Chat | `mod+shift+r` | Retry last turn |
| Chat | `mod+shift+y` | Why this model? |
| Chat | `mod+f` | Find in thread |
| Workspace | `mod+p` | Quick open |
| Workspace | `mod+shift+f` | Search workspace |
| Workspace | `mod+s` | Save |
| Workspace | `mod+w` | Close tab |
| Workspace | `mod+shift+w` | Close all tabs |
| Workspace | `mod+\` | Split editor |
| Workspace | `mod+shift+e` | Focus file tree |
| Workspace | `alt+←` / `alt+→` | Previous / next tab |
| Workspace | `←` / `→` | Collapse / expand tree node |
| Tasks | `mod+shift+n` | New task |
| Tasks | `space` | Expand timeline step |
| Tasks | `mod+.` | Stop task |
| Tasks | `mod+shift+r` | Retry from step |
| Lanes | `mod+alt+←` / `mod+alt+→` | Move task between lanes |
| Review | `n` / `p` | Next / previous hunk |
| Review | `a` / `r` | Accept / reject hunk |
| Review | `shift+a` / `shift+r` | Accept / reject file |
| Review | `mod+z` | Undo review action |
| Review | `mod+enter` | Apply accepted changes |
| Review | `u` | Unified / split |
| Models | `mod+shift+c` | Compare selected |
| Models | `space` | Pin focused model |
| Providers | `mod+shift+t` | Test provider |
| Providers | `mod+shift+d` | Run discovery |
| Generations | `mod+enter` | Generate |
| Generations | `mod+s` | Save focused asset |
| Any table or list | `↑` / `↓` / `Home` / `End` | Move; single tab stop |
| Any table or list | `enter` | Open the focused row |
| Any tab strip | `←` / `→` / `Home` / `End` | Move tabs |
| Any split | `←` / `→` / `Home` / `End` | Resize the focused handle |

### 24.2 Checklist for a new screen

Before a screen is considered done, all fourteen must be true.

1. It composes only from the inventory in §1.1. No new primitive, no literal colour, no height
   off the scale in §2.
2. Its main region is a `Panel` (or a `SplitPane` of `Panel`s) with `title`, so the region has an
   accessible name.
3. It has an empty state for "never created" and, where filtering exists, a separate one for
   "filtered to nothing" with `live`.
4. It has a loading state built from `Skeleton` at the real row heights, or `Table loading`.
5. It has a region-tier error state that does not take the rest of the screen down with it.
6. Every destructive action either confirms through a `dismissible={false}` `Dialog` or offers an
   undo toast. Never both, never neither.
7. Every icon-only control has a `label`.
8. Every status is carried by shape as well as colour (`StatusChip`, `TimelineStep`).
9. Every column of numbers carries `.mrd-numeric`.
10. Every row that supports arrow navigation is inside a `List` or a selectable `Table`, so the
    screen contributes one tab stop, not fifty.
11. Its shortcuts are in §24.1, in `matchesShortcut` form, and appear in the palette.
12. It behaves at 640px, 900px, 1200px and 1600px, and it says which region leaves the layout
    first.
13. It renders correctly in dark mode, in `prefers-contrast: more`, and with reduced motion — all
    three come free if every value is a token, and all three break the moment one is not.
14. Nothing it renders claims a certainty the data does not have: `null` is not zero, `unknown`
    is not "allowed", a promotional credit is not a free tier, and a partial write is not a
    success.
