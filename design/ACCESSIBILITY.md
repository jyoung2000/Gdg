# Accessibility

Meridian targets **WCAG 2.2 AA**. This document states the contract as
requirements a reviewer can check, and is honest about the gaps.

Accessibility here is not a compliance exercise. A gateway is an operations
tool: people read it under time pressure, in the dark, on a laptop screen in a
bright room, or entirely from the keyboard while their hands are on a terminal.
Everything below exists because one of those situations breaks otherwise.

---

## 1. Colour contrast

Ratios below are computed from the literal values in
`packages/ui/src/tokens/tokens.css` using the WCAG relative-luminance formula.

### Light theme

| Foreground | Background | Ratio | Requirement | Result |
| --- | --- | --- | --- | --- |
| `--color-text-primary` `#1c1b19` | `--color-bg` `#f7f6f4` | **15.93:1** | 4.5:1 body | Pass |
| `--color-text-primary` `#1c1b19` | `--color-surface` `#ffffff` | **17.21:1** | 4.5:1 body | Pass |
| `--color-text-secondary` `#6a6862` | `--color-surface` `#ffffff` | **5.57:1** | 4.5:1 body | Pass |
| `--color-text-tertiary` `#726f6a` | `--color-surface` `#ffffff` | **5.0:1** | 4.5:1 body | Pass |
| `--color-text-tertiary` `#726f6a` | `--color-bg` `#f7f6f4` | **4.63:1** | 4.5:1 body | Pass |
| `--color-accent` `#2f6ae8` | `--color-surface` `#ffffff` | **4.83:1** | 4.5:1 body | Pass |
| `--color-text-on-accent` `#ffffff` | `--color-accent` `#2f6ae8` | **4.83:1** | 4.5:1 body | Pass |
| `--color-error` `#c8322f` | `--color-surface` `#ffffff` | **5.31:1** | 4.5:1 body | Pass |
| `--color-success` `#177a4c` | `--color-surface` `#ffffff` | **5.35:1** | 4.5:1 body | Pass |
| `--color-warning` `#96620e` | `--color-surface` `#ffffff` | **5.18:1** | 4.5:1 body | Pass |

### Dark theme

| Foreground | Background | Ratio | Requirement | Result |
| --- | --- | --- | --- | --- |
| `--color-text-primary` `#f0efed` | `--color-bg` `#171718` | **15.59:1** | 4.5:1 body | Pass |
| `--color-text-primary` `#f0efed` | `--color-surface` `#1e1e20` | **14.48:1** | 4.5:1 body | Pass |
| `--color-text-secondary` `#9e9c97` | `--color-surface` `#1e1e20` | **6.07:1** | 4.5:1 body | Pass |
| `--color-text-tertiary` `#8a8882` | `--color-surface` `#1e1e20` | **4.7:1** | 4.5:1 body | Pass |
| `--color-accent` `#5b8dff` | `--color-surface` `#1e1e20` | **5.31:1** | 4.5:1 body | Pass |
| `--color-error` `#f2635f` | `--color-surface` `#1e1e20` | **5.33:1** | 4.5:1 body | Pass |
| `--color-success` `#3fbc80` | `--color-surface` `#1e1e20` | **6.91:1** | 4.5:1 body | Pass |
| `--color-warning` `#dfa044` | `--color-surface` `#1e1e20` | **7.33:1** | 4.5:1 body | Pass |

Every ratio above was computed from the literal token values with the WCAG
relative-luminance formula, not estimated. Three tokens were changed during
this audit because the original values did not pass:

| Token | Was | Ratio | Now | Ratio |
| --- | --- | --- | --- | --- |
| `--color-text-tertiary` (light) | `#9c9992` | 2.84:1 | `#726f6a` | 5.00:1 |
| `--color-text-tertiary` (dark) | `#6e6c68` | 3.18:1 | `#8a8882` | 4.70:1 |
| `--color-success` (light) | `#1b8a56` | 4.36:1 | `#177a4c` | 5.35:1 |
| `--color-warning` (light) | `#b3720f` | 3.94:1 | `#96620e` | 5.18:1 |

The tertiary failure mattered most: it is the caption colour, so it carries
model metadata, latency figures and cost — exactly the text an operator squints
at.

**Rules that follow from the table.**

- `--color-text-tertiary` is for captions, placeholders, disabled text and
  metadata. It now meets the body-text threshold, so it may carry words, but it
  is still never the *sole* carrier of information.
- `--color-border` and `--color-separator` are decorative. Any boundary that
  carries meaning — a focus ring, a selected row — also changes fill or text.

### High contrast

`@media (prefers-contrast: more)` raises border and separator alpha and darkens
(or lightens) secondary and tertiary text. It changes no hues, so the interface
stays recognisably itself.

---

## 2. Status is never colour alone

Every status carries a **glyph and text** as well as a colour. `StatusChip`
pairs each status with a distinct mark:

| Status | Mark | Colour |
| --- | --- | --- |
| ready / healthy | filled dot | success |
| busy | pulsing dot | accent |
| rate limited | half dot | warning |
| degraded | slashed circle | warning |
| offline | hollow ring | error |
| unknown | dash | tertiary |

The same rule applies to `Timeline` step states, diff add/delete markers,
the routing-explanation criteria list (`✓` / `·` plus an `mrd-sr-only`
"met"/"not met"), and the file-tree change dots (which carry a `title`).

Printed in greyscale, every one of those remains readable.

---

## 3. Keyboard

Every action reachable with a pointer is reachable from the keyboard.

| Pattern | Keys |
| --- | --- |
| Command palette | `⌘K` / `Ctrl+K`, `Esc` to close, `↑` `↓` to move, `↵` to run |
| Sidebar toggle | `⌘B` / `Ctrl+B` |
| Terminal drawer | `⌘J` / `Ctrl+J` |
| Assistant panel | `⌘I` / `Ctrl+I` |
| Save file | `⌘S` / `Ctrl+S` in the editor |
| Send message | `↵`; `Shift+↵` for a newline |
| Menus | `↑` `↓` with wraparound, `Home`/`End`, first-letter typeahead, `Esc` closes and restores focus |
| Tabs | `←` `→` roving tabindex, `Home`/`End` |
| Lists and listboxes | `↑` `↓`, `Home`/`End`, `↵` activates |
| Split panes | The divider is `role="separator"` with `aria-valuenow`; arrows resize |
| Dialogs and sheets | Focus trapped, `Esc` closes when dismissible, focus restored to the opener |

A **skip link** (`.mrd-skip-link`) is the first focusable element and jumps to
`#main`.

---

## 4. Focus

- `:focus-visible` only — a pointer click does not paint a ring, a `Tab` does.
- The ring is drawn with `outline` or `box-shadow`, never `border`, so it
  follows `border-radius` and never shifts layout.
- Components that draw their own ring add `.mrd-focus-ring` and opt out of the
  global outline.
- Focus is never removed. There is no `outline: none` without a replacement.

---

## 5. Screen-reader semantics

| Pattern | Contract |
| --- | --- |
| Dialog | `role="dialog"`, `aria-modal="true"`, labelled by its title, focus trapped and restored |
| Sheet | Same as Dialog |
| Menu | `role="menu"` / `menuitem`, `aria-expanded` and `aria-controls` on the trigger |
| Tabs | `tablist` / `tab` / `tabpanel`, `aria-selected`, `aria-controls` |
| Listbox | `role="listbox"` / `option` with `aria-selected` when selectable, otherwise `list` / `listitem` |
| Command palette | `role="combobox"` with `aria-expanded`, `aria-controls`, `aria-activedescendant` |
| Progress | `role="progressbar"` with `aria-valuenow` / `min` / `max`; indeterminate omits `valuenow` |
| Toast | `role="status"` `aria-live="polite"`; errors use `role="alert"` `aria-live="assertive"` |
| Switch | `role="switch"` with `aria-checked` |
| Table | Real `<table>`; sortable headers are buttons carrying `aria-sort` |
| Timeline | Ordered list; expandable steps are buttons with `aria-expanded` |
| Disclosure | Button with `aria-expanded` and `aria-controls` |
| Tooltip | `role="tooltip"` wired by `aria-describedby`; never holds interactive content |
| Icon | `aria-hidden="true"` unless given a `title`, in which case `role="img"` |

**Accessible names.** Every icon-only control requires a `label` prop — it is
not optional in `IconButton`'s type, so an unnamed icon button does not compile.

---

## 6. Motion

- Duration tokens collapse to `1ms` under `prefers-reduced-motion: reduce` and
  under the in-app `data-reduce-motion="true"` preference.
- They collapse to 1ms rather than 0 so `transitionend` still fires and state
  machines waiting on it do not stall.
- Animations that are meaningless at 1ms are disabled outright rather than
  sped up: the streaming caret stops blinking and holds at 0.6 opacity, and the
  skeleton shimmer becomes a static tint.
- No animation conveys information on its own.

---

## 7. Text scaling and zoom

- The layout is flex and grid throughout with no fixed heights on text
  containers, so it reflows at 200% zoom.
- `--sidebar-width`, `--inspector-width` and `--drawer-height` are the only
  fixed dimensions, and each becomes an overlay or collapses below its
  breakpoint.
- Wide content — tables, code, diffs, the terminal — scrolls inside its own
  `overflow-x: auto` container. The shell never scrolls horizontally, verified
  at 1600px, 900px and 390px.

---

## 8. Touch

- Controls are at least 28px (`--control-height`) with an additional hit area
  on small variants; resizer handles extend their target 4px either side of the
  1px visible line.
- Hover-only affordances always have a non-hover equivalent: a tooltip's content
  is also the control's accessible name.

---

## 9. Forms

- Every control is labelled, by a `<label>` or an `aria-label`.
- `Field` and `FormRow` wire `description` and `error` through
  `aria-describedby`, and set `aria-invalid` when invalid.
- Errors are text, next to the control, not a colour change alone.

---

## 10. Per-screen review checklist

Run this against each screen. It is the list the implementation was checked
against.

1. `Tab` from the top reaches every control in a sensible order and nothing is
   focusable that should not be.
2. Every focused element shows a visible ring.
3. Nothing is announced only by colour.
4. Every icon-only control has a name in the accessibility tree.
5. Overlays trap focus, close on `Esc`, and return focus to the opener.
6. The page has one `h1` and a sensible heading order.
7. At 200% zoom nothing is clipped and the shell does not scroll sideways.
8. At 390px wide the shell does not scroll sideways.
9. With `prefers-reduced-motion` set, nothing animates meaninglessly.
10. In greyscale, every status is still distinguishable.

---

## 11. Known gaps

Stated plainly rather than omitted.

- **No automated accessibility test suite.** The checks above were performed by
  inspection and with a headless browser sweep that verifies rendering, console
  cleanliness and horizontal overflow at three viewports. Adding `axe-core` to
  the browser sweep is the obvious next step.
- **The embedded editor and terminal carry their own semantics.** CodeMirror
  and xterm.js are keyboard-accessible and are themed from Meridian's tokens,
  but their internal accessibility behaviour is theirs, not Meridian's.
- **No screen-reader testing on a real assistive technology** has been done in
  this environment. The semantics are correct by construction and by review;
  they have not been heard.
