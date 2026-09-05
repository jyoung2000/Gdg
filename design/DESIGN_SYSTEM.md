# Meridian Design System

The reference for Meridian's interface layer. Every token, component and rule
described here exists in `packages/ui/src`. Where this document and the code
disagree, the code is right and this document is a bug.

Source of truth, in order:

| Layer | File | Role |
| --- | --- | --- |
| Tokens | `packages/ui/src/tokens/tokens.css` | Every colour, size, radius, shadow, duration and layout constant |
| Typed mirror | `packages/ui/src/tokens/tokens.ts` | Token names for TypeScript, as `var()` strings |
| Base | `packages/ui/src/tokens/base.css` | Reset, document defaults, focus, scrollbars, typography and layout utilities |
| Primitives | `packages/ui/src/primitives/` | Button, Form, Controls, Overlay |
| Layouts | `packages/ui/src/layouts/Layout.tsx` | Shell surfaces: panel, toolbar, sidebar, split pane, inspector |
| Components | `packages/ui/src/components/Data.tsx` | List, Table, Timeline, KeyValue |

Class names are prefixed `mrd-`, with `mrd-block__element` for parts and
`mrd-block--modifier` for variants. Variant and size are classes. State is never
a class; see [States](#9-states).

---

## 1. Design philosophy

Meridian is a workstation for people who run AI infrastructure. It is looked at
for hours, not glanced at. It shows dense, live, numeric data that changes while
being read. Every principle below follows from that.

This is an original design language informed by desktop-software principles —
clarity, hierarchy, restraint, precision, direct manipulation, calm surfaces. It
is not derived from, endorsed by, or a copy of any vendor's design system.

### 1.1 The principles

**Clarity before decoration.** A surface earns its treatment by carrying
meaning. A hairline that separates two regions is doing work. A gradient behind
a heading is not.

**Hierarchy from typography first.** Before reaching for a border, a card or a
shadow, change the size, weight and colour of the text. The type scale spans
30px down to 11px with three text colours; that is enough to express most
structure with no boxes at all. Boxes are what you use when typography has
already run out.

**Restraint in colour.** The interface is neutral. The accent appears in exactly
four situations — selection, focus, the single primary action in a view, and
status. A screen with accent in a fifth place has lost the ability to say which
thing matters.

**Density without noise.** The base size is 13px and the base row is 26px
because the work is comparing many things at once. Density is bought with
whitespace discipline and hairlines, not by shrinking the type until it hurts.

**Precision.** Values come from scales. A 13px gap, a 7px radius or a 200ms
transition means someone guessed, and the guess is now permanent.

**Direct manipulation.** Panes resize by dragging. Rows select by arrow keys.
Controls move under the pointer — the button travels 0.5px on press, the card
lifts 1px on hover. The response is small and immediate rather than large and
delayed.

**Calm surfaces.** Nothing moves unless the user moved it or something arrived.
Ambient animation in a monitoring tool competes with the data it is monitoring.

### 1.2 The never list

These are not preferences. Each rules out a class of change.

**Never generic SaaS cards everywhere.** A card is a grouping surface for
repeated things — a provider, a model, a route. Wrapping every region in a
rounded white box flattens the hierarchy to one level and wastes the padding on
nothing. Regions are `Panel`; repeated items are `Card`; most things are neither.

**Never excessive gradients.** There is no gradient token. The only gradients in
the codebase are the skeleton shimmer and the meter's fill. A gradient used as a
background is a colour that cannot be reasoned about in either theme.

**Never oversized text.** `--text-display-size` is 30px and it exists for the
one place per view that carries the view's identity. There is no marketing type
scale. If a heading needs to be larger to be found, the layout is wrong.

**Never giant rounded containers.** The largest radius in the stylesheets is
`--radius-2xl` at 16px, and it is reserved for overlay surfaces: popover, dialog,
sheet. A 24px radius on a data panel makes a control panel look like a phone app
and eats the corners where content wants to sit.

**Never inconsistent iconography.** One grid, one stroke treatment, a fixed set
of rendered sizes. A mixed-weight icon set reads as a bug even to people who
cannot say why.

**Never random shadows.** Five elevation levels exist and each has a meaning.
A shadow that is not `--shadow-0` … `--shadow-4` is a shadow that will not
change with the theme and will not match the surface next to it.

**Never arbitrary colours.** Every colour is a token reference. A literal colour
in a component cannot follow the theme, cannot respond to `prefers-contrast`,
and cannot be changed in one place. There are exactly two literal colours in the
component layer today, both in `Button.css`; do not add a third.

**Never arbitrary spacing.** The scale is `--space-1` … `--space-11`. A value
off it is a defect, not a judgement call.

**Never excessive animation.** Motion says a thing moved, arrived or changed
state. It never decorates. Loops that carry no information stop entirely under
reduced motion; loops that assert "still working" slow down instead, because
stopping them would be a false statement.

---

## 2. Colour

### 2.1 The layered-surface model

Depth is a stack of surfaces, not a stack of shadows. Reading up from the ground:

```
--color-bg              the application ground; nothing floats behind it
--color-surface-sunken  a well cut into the ground: a track, an inset region
--color-surface         the working surface: panels, cards, inputs, dialogs
--color-surface-raised  a surface above a surface: a toast over a panel
--color-overlay         a translucent surface over everything: popover, tooltip
```

Two chrome surfaces sit outside this ladder because they are translucent by
design: `--color-sidebar` and `--color-toolbar`. `--color-panel` is the panel
region's own surface; it is distinct from `--color-surface` so panels can be
retinted without touching every input and card in the product.

`--color-scrim` darkens everything behind a modal. It is not a surface.

### 2.2 Why the light ground is warm off-white

`--color-bg` is `#f7f6f4`, not `#ffffff`. Under a full-height application, pure
white behaves as a light source: it glares over long sessions, and it leaves
nothing for the white surfaces above it to sit on. A slightly warm, slightly
darker ground gives `--color-surface: #ffffff` a step to stand on, so a panel
reads as raised without needing a shadow to say so. The warmth also softens the
neutral text greys, which are themselves warm (`#1c1b19`, not `#000`).

### 2.3 Why dark mode is not an inversion

Inverting the light palette produces a dark theme that is wrong in three
specific ways, and each is corrected explicitly:

1. **The ground is not black.** `--color-bg` is `#171718`. On `#000` there is no
   room below the surfaces, so every panel has to be lighter than the ground by
   a large step and begins to glow. A near-black ground leaves headroom for
   `#1e1e20` surfaces and `#26262a` raised surfaces, and the ladder still reads.
2. **Hairlines change alpha, not just colour.** A light hairline on a dark
   ground reads thinner than a dark hairline of the same opacity on a light
   ground — the eye's response to a light line on dark is not the mirror of the
   opposite case. So `--color-border` moves from `rgba(28, 27, 25, 0.12)` to
   `rgba(255, 255, 255, 0.11)`, and the neutral fills all rise:
   `--color-fill-hover` goes from `0.062` to `0.075`, `--color-fill-active` from
   `0.095` to `0.11`. The numbers are not symmetric because the perception is
   not symmetric.
3. **The accent is lifted, not inverted.** `#2f6ae8` has enough contrast against
   white; against `#171718` it is a dark blue on a dark ground. Dark mode uses
   `#5b8dff`, a lighter and less saturated blue, and its hover goes *up* in
   lightness (`#7aa2ff`) where the light theme's hover goes *down* (`#2a5fd0`).
   Hover always means "further from the surface", which is a different direction
   in each theme.

Shadows are also not inverted. On a dark ground a soft shadow carries almost no
information — depth there comes from surface lightness — so the dark overrides
keep the same geometry but raise the alpha and rely on it only as a contact
shadow.

### 2.4 The accent rule

`--color-accent` and its family appear in exactly four situations:

| Situation | Treatment |
| --- | --- |
| Selection | `--color-accent-subtle` fill, `--color-accent-subtle-hover` on hover; `--color-accent-border` for a selected outline |
| Focus | `--shadow-focus` halo plus a 1px `--color-accent` ring, or the 2px accent outline from `base.css` |
| The one primary action in a view | `--color-accent` fill, `--color-text-on-accent` label |
| Status | Via `--color-info`, which aliases the accent |

Everything else is neutral: `--color-fill-quiet` / `-hover` / `-active` for
control backgrounds, and the three text greys for hierarchy. A secondary button
is white with a hairline. A tertiary button is transparent. This is why the
primary button is findable at a glance in a screen with forty controls on it.

### 2.5 Surfaces

| Token | Light | Dark | For |
| --- | --- | --- | --- |
| `--color-bg` | `#f7f6f4` | `#171718` | Application ground, `body` background |
| `--color-surface` | `#ffffff` | `#1e1e20` | Working surface: cards, inputs, dialogs, buttons |
| `--color-surface-raised` | `#ffffff` | `#26262a` | A surface above a surface: toasts, the skip link |
| `--color-surface-sunken` | `#f1f0ed` | `#131314` | Wells cut into the ground; today, the empty-state icon disc |
| `--color-sidebar` | `rgba(247, 246, 244, 0.82)` | `rgba(23, 23, 24, 0.78)` | Translucent sidebar chrome |
| `--color-toolbar` | `rgba(255, 255, 255, 0.72)` | `rgba(30, 30, 32, 0.68)` | Translucent top chrome |
| `--color-panel` | `#ffffff` | `#1e1e20` | Panel and sheet surface |
| `--color-overlay` | `rgba(255, 255, 255, 0.86)` | `rgba(38, 38, 42, 0.86)` | Popover and tooltip surface, behind a blur |
| `--color-scrim` | `rgba(28, 27, 25, 0.28)` | `rgba(0, 0, 0, 0.5)` | Behind a modal |

### 2.6 Hairlines

| Token | Light | Dark | For |
| --- | --- | --- | --- |
| `--color-separator` | `rgba(28, 27, 25, 0.07)` | `rgba(255, 255, 255, 0.07)` | A division you should barely notice: panel edges, header rules, table rows |
| `--color-border` | `rgba(28, 27, 25, 0.12)` | `rgba(255, 255, 255, 0.11)` | The edge of an interactive thing: a button, an input, a menu |
| `--color-border-strong` | `rgba(28, 27, 25, 0.2)` | `rgba(255, 255, 255, 0.2)` | Input hover, scrollbar thumb, anything that must be found |

Two weights, not five. The distinction is functional: a separator says "these
are different regions"; a border says "this responds to the pointer".

### 2.7 Text

| Token | Light | Dark | For |
| --- | --- | --- | --- |
| `--color-text-primary` | `#1c1b19` | `#f0efed` | Content, labels, values |
| `--color-text-secondary` | `#6a6862` | `#9e9c97` | Supporting text, tertiary button labels, icon-button rest |
| `--color-text-tertiary` | `#9c9992` | `#6e6c68` | Metadata, panel titles, placeholders, disabled text |
| `--color-text-inverse` | `#ffffff` | `#171718` | Text on an inverted surface |
| `--color-text-on-accent` | `#ffffff` | `#ffffff` | Text on an accent fill — the same in both themes, because the accent fill is dark enough in both |

### 2.8 Accent

| Token | Light | Dark | For |
| --- | --- | --- | --- |
| `--color-accent` | `#2f6ae8` | `#5b8dff` | Primary fill, focus ring, selected text and glyphs |
| `--color-accent-hover` | `#2a5fd0` | `#7aa2ff` | Primary hover |
| `--color-accent-active` | `#2454b8` | `#4a7cf0` | Primary press |
| `--color-accent-subtle` | `rgba(47, 106, 232, 0.1)` | `rgba(91, 141, 255, 0.16)` | Selection fill, pressed icon button, focus halo |
| `--color-accent-subtle-hover` | `rgba(47, 106, 232, 0.16)` | `rgba(91, 141, 255, 0.24)` | Hover on a selected row; text selection |
| `--color-accent-border` | `rgba(47, 106, 232, 0.35)` | `rgba(91, 141, 255, 0.42)` | Outline of a selected surface |

### 2.9 Status

| Token | Light | Dark | For |
| --- | --- | --- | --- |
| `--color-success` | `#1b8a56` | `#3fbc80` | Healthy, complete, added |
| `--color-success-subtle` | `rgba(27, 138, 86, 0.12)` | `rgba(63, 188, 128, 0.16)` | Success chip and badge fill |
| `--color-warning` | `#b3720f` | `#dfa044` | Degraded, rate limited, needs attention |
| `--color-warning-subtle` | `rgba(179, 114, 15, 0.13)` | `rgba(223, 160, 68, 0.16)` | Warning chip and badge fill |
| `--color-error` | `#c8322f` | `#f2635f` | Failed, invalid, destructive |
| `--color-error-subtle` | `rgba(200, 50, 47, 0.11)` | `rgba(242, 99, 95, 0.16)` | Error chip, badge and destructive button fill |
| `--color-info` | `var(--color-accent)` | resolves through the accent | Informational status |
| `--color-info-subtle` | `var(--color-accent-subtle)` | resolves through the accent | Informational fill |

`--color-info` needs no dark override. It is declared once as
`var(--color-accent)`, and custom-property substitution happens where the token
is *used*, so it picks up whichever accent the active theme defines.

Status colour never carries meaning on its own; see
[12.6 Colour independence](#126-colour-independence).

### 2.10 Diff

| Token | Light | Dark | For |
| --- | --- | --- | --- |
| `--color-diff-add-bg` | `rgba(27, 138, 86, 0.11)` | `rgba(63, 188, 128, 0.15)` | Added line background |
| `--color-diff-add-text` | `#12633c` | `#6fd6a1` | Added line text |
| `--color-diff-del-bg` | `rgba(200, 50, 47, 0.1)` | `rgba(242, 99, 95, 0.14)` | Removed line background |
| `--color-diff-del-text` | `#97231f` | `#ff8a86` | Removed line text |
| `--color-diff-gutter` | `rgba(28, 27, 25, 0.04)` | `rgba(255, 255, 255, 0.04)` | Line-number gutter |

These are deliberately not `--color-success` and `--color-error`. A deletion is
not a failure, and a rejected hunk is not a removed line; giving them the same
colour would make two different things look identical in the one view where the
difference matters most. The diff tokens are declared but not yet consumed by a
component — the diff surface is not built.

### 2.11 Neutral fills

| Token | Light | Dark | For |
| --- | --- | --- | --- |
| `--color-fill-quiet` | `rgba(28, 27, 25, 0.045)` | `rgba(255, 255, 255, 0.05)` | Resting fill of a quiet control; secondary button hover; neutral badge |
| `--color-fill-hover` | `rgba(28, 27, 25, 0.062)` | `rgba(255, 255, 255, 0.075)` | Hover on a transparent control |
| `--color-fill-active` | `rgba(28, 27, 25, 0.095)` | `rgba(255, 255, 255, 0.11)` | Press; slider and switch track |
| `--color-fill-selected` | `rgba(28, 27, 25, 0.075)` | `rgba(255, 255, 255, 0.09)` | Neutral selection, for selections that must not read as accent |

`--color-fill-selected` is declared but not yet used by a component. It is the
right token if you need a selection that must not compete with an accent
selection elsewhere on the same screen.

---

## 3. Typography

### 3.1 The font stack

```css
--font-sans: Inter, -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', 'Segoe UI',
  system-ui, 'Helvetica Neue', Arial, sans-serif;
--font-mono: 'SF Mono', ui-monospace, 'JetBrains Mono', 'Cascadia Code', Menlo, Consolas,
  'Liberation Mono', monospace;
```

Inter first, then the platform UI faces, then `system-ui`. The stack is
system-oriented on purpose: at 13px, a face designed and hinted for interface
text at small sizes is legible in a way a webfont chosen for personality is not,
and the platform face is already resident, already subpixel-tuned for that
platform, and never arrives late. Inter leads because it is metrically close to
the platform faces and gives a consistent baseline across operating systems when
it is available; when it is not, the fallback is a face the machine was designed
around, not a substitute.

`base.css` sets `font-synthesis-weight: none` on `body`, so a weight that does
not exist is never faked into a smeared bold; `-webkit-font-smoothing: antialiased`
and `text-rendering: optimizeLegibility` are set there too.

### 3.2 The scale

`body` is set to the body tokens, so unstyled text is already correct. The
utility classes in `base.css` apply each step.

| Utility | Size token | Size | Line | Weight | Tracking | Use |
| --- | --- | --- | --- | --- | --- | --- |
| `.mrd-display` | `--text-display-*` | 30px | 36px | 600 | −0.021em | The one thing per view that carries its identity |
| `.mrd-title` | `--text-title-*` | 21px | 27px | 600 | −0.016em | A view or dialog title |
| `.mrd-section-title` | `--text-section-*` | 15px | 21px | 600 | −0.009em | Panel headers, group titles |
| `.mrd-panel-title` | `--text-panel-*` | 11px | 15px | 600 | +0.045em | Uppercase label for a dense sub-panel or sidebar section |
| `.mrd-body` | `--text-body-*` | 13px | 19px | 400 | −0.002em | Everything |
| `.mrd-body-lg` | `--text-body-lg-*` | 14px | 21px | inherited | inherited | Reading text: a dialog description, an empty-state sentence |
| `.mrd-secondary` | `--text-secondary-*` | 12px | 17px | inherited | inherited | Supporting text; also sets `--color-text-secondary` |
| `.mrd-caption` | `--text-caption-*` | 11px | 15px | inherited | inherited | Metadata; also sets `--color-text-tertiary` |
| `.mrd-code` | `--text-code-*` | 12.5px | 19px | inherited | inherited | Monospace, via `--font-mono` |

Only the display, title, section, panel and body steps declare weight and
tracking tokens. The rest inherit, which is what keeps a `.mrd-secondary` label
inside a bold header from silently un-bolding itself.

Negative tracking increases as size increases (−0.002em at 13px, −0.021em at
30px) because letterfit that looks correct at body size looks loose when the
same face is set large. The panel step is the only positive tracking in the
system, and it exists because uppercase needs it.

`--text-code-size` is 12.5px rather than 13px: a monospace face at the same
nominal size as the sans face reads noticeably larger, and half a pixel is what
brings a code span back into line with the prose around it.

### 3.3 Hierarchy before boxes

Given a region with a title, three groups and twelve values, the first tool is
the type scale plus the three text colours:

- Group titles: `.mrd-panel-title` — 11px, 600, uppercase, tertiary.
- Values: `.mrd-body` in `--color-text-primary`.
- Units and timestamps: `.mrd-secondary` or `.mrd-caption`.

That produces three readable levels with no borders at all. Only when the groups
must be separately scrollable, separately actionable, or separately positioned
does a `Panel` or `Card` become the right answer. A card whose only job is to
draw a line between two paragraphs should have been a `<hr>` or nothing.

### 3.4 Uppercase, in exactly one place

`.mrd-panel-title` is the only uppercase style. Uppercase destroys word shape and
slows reading, which is exactly right for something that must be recognised as a
label and not read as content, and exactly wrong for anything else. It comes with
+0.045em tracking, because uppercase set at normal tracking sets too tight, and
with `--color-text-tertiary`, because the label is scaffolding.

Used by: `PanelHeader` with `variant="label"`, and `SidebarSection` titles.

### 3.5 Tabular numerals

`.mrd-numeric` sets `font-variant-numeric: tabular-nums` and
`font-feature-settings: 'tnum' 1`. It is **mandatory** anywhere a number can
change while it is on screen or be compared down a column. Proportional digits
have different widths, so a live latency counter jitters horizontally on every
update and a column of costs will not align on its decimal point — the eye
compares columns of figures by their right edge, and proportional figures move
that edge on every render.

Applied today by:

| Where | Component |
| --- | --- |
| End-aligned table headers and cells | `Table` |
| Step durations | `TimelineStep` |
| Values marked `numeric: true` | `KeyValue` |
| Sidebar item badges | `SidebarItem` |
| Tab counts | `Tab` |
| Badge counts | `Badge` |
| Slider value readout | `Slider` |
| Meter value readout | `Meter` |
| Star rating value | `Stars` |
| Menu item shortcuts | `Overlay.css` sets `font-variant-numeric: tabular-nums` directly |

If you add a live counter and do not add `.mrd-numeric`, that is a defect.

---

## 4. Spacing

### 4.1 The scale

| Token | Value | Typical use |
| --- | --- | --- |
| `--space-1` | 4px | Icon-to-label inside a dense chip; toolbar group gap |
| `--space-2` | 8px | Gap between controls; small control padding; popover padding |
| `--space-3` | 12px | Default button padding; panel header gap; toast padding |
| `--space-4` | 16px | Panel body and card padding; large button padding |
| `--space-5` | 20px | Sidebar section spacing; dialog header padding |
| `--space-6` | 24px | Empty-state horizontal padding; the gap between a menu item's label and its shortcut |
| `--space-7` | 32px | The scrim's padding around a modal; the viewport margin a popover or sheet keeps from the edge |
| `--space-8` | 40px | The table's empty and loading padding; a `lg` avatar; a block skeleton |
| `--space-9` | 48px | Empty-state vertical padding, and its icon disc |
| `--space-10` | 64px | Declared for page-level margins; no stylesheet uses it yet |
| `--space-11` | 80px | The largest step; used to derive the `md` dialog width and the tooltip's max width |

Eleven steps, roughly 4px-based to `--space-6` and then opening up. The scale is
deliberately dense at the bottom because that is where interface work happens.

### 4.2 Off-scale values are a defect

`padding: 13px` is not a small imprecision; it is a value that no other element
in the product shares, which means it will never line up with anything and will
never be found again when the density of a region is retuned. The same applies
to `gap: 10px` and `margin-top: 6px`.

Two legitimate escapes exist, and both stay on the scale:

```css
/* Derive from the scale with calc, rather than inventing a number. */
--mrd-switch-width: calc(var(--space-6) + var(--space-1));   /* 28px */
--mrd-switch-inset: calc(var(--space-1) / 2);                /* 2px  */

/* Pull a trailing control back to the edge it belongs to. */
margin-right: calc(var(--space-1) * -1);
```

Values that are genuinely not spacing — a 1px hairline, a 1.5px spinner stroke,
a 0.5px press travel, a glyph's rendered pixel size — are written literally,
because they are geometry, not rhythm.

### 4.3 Worked examples

A panel body with a stack of fields:

```tsx
<Panel title="Provider" elevation={1}>
  <PanelBody>
    <Stack direction="column" gap={4}>
      <Field label="Base URL">
        <Input fullWidth placeholder="https://api.example.com" />
      </Field>
      <Field label="Timeout" description="Applies to every request on this route.">
        <Input fullWidth type="number" adornment="ms" />
      </Field>
    </Stack>
  </PanelBody>
</Panel>
```

`PanelBody` supplies `--space-4` of padding (`.mrd-panel-body--padded`).
`Stack`'s `gap` prop is an index into the scale — its type is
`StackGap = 1 | ... | 11`, so an off-scale gap is not expressible. It is applied
as a token reference, not a resolved value:

```tsx
const gapStyle = gap ? ({ '--mrd-stack-gap': `var(--space-${gap})` } as CSSProperties) : undefined;
```

A toolbar row:

```css
.mrd-toolbar {
  gap: var(--space-2);          /* 8px between controls */
  padding: 0 var(--space-3);    /* 12px at the ends */
  height: var(--toolbar-height);
}
.mrd-toolbar__group {
  gap: var(--space-1);          /* 4px inside a group — tighter than between groups */
}
```

The 4px-inside / 8px-between relationship is what makes toolbar groups read as
groups without any separator being drawn.

---

## 5. Radius

### 5.1 The scale

| Token | Value | Class of element |
| --- | --- | --- |
| `--radius-sm` | 6px | Small controls: `sm` buttons and inputs, icon buttons at `sm`, skeleton text lines, the search clear button, the global `:focus-visible` fallback |
| `--radius-md` | 8px | Default controls: `Button`, `IconButton`, `Input`, the skip link, joined button-group ends |
| `--radius-lg` | 10px | Small surfaces and control-scale panels: `Card`, `MenuItem`, `Tooltip`, skeleton blocks |
| `--radius-xl` | 12px | Region surfaces: `Panel`, `Toast`, `Fieldset` group, `.mrd-surface` |
| `--radius-2xl` | 16px | Overlay surfaces: `Popover`, `Dialog`, `Sheet` |
| `--radius-3xl` | 20px | Declared, and mirrored in `tokens.ts`; no stylesheet uses it |
| `--radius-pill` | 999px | Pills only — see below |

The scale is restrained on purpose. Radius reads as softness, and softness reads
as informality; a control surface that rounds too hard stops looking like an
instrument. The step from a control (8px) to a region (12px) to an overlay (16px)
is also a legibility device: nested corners must grow outward or the inner
element appears to bulge out of the outer one.

`Tooltip` takes `--radius-lg` rather than an overlay radius, and its stylesheet
says why: a tip is control-scale, not panel-scale, and the surface radius would
round a two-line tip into a pill.

### 5.2 The pill rule

`--radius-pill` is for status and tags — things whose shape is part of their
meaning. In the codebase it is used by `Badge`, `StatusChip`, `Tabs` set to
`variant="pill"` (filter tabs), the sidebar item's pending dot, `Avatar`,
circular skeletons and the scrollbar thumb.

It is not for buttons. A pill-shaped button is a call to action, and Meridian
has no calls to action — it has controls. Note that `Switch` derives its stadium
shape from its own track height (`calc(var(--mrd-switch-height) / 2)`) rather
than taking the pill token, so the knob and track stay in proportion at any size.

---

## 6. Elevation and materials

### 6.1 The five levels

| Level | Token | Light value | Dark value | What lives here |
| --- | --- | --- | --- | --- |
| 0 | `--shadow-0` | `none` | `none` | The application ground and flat surfaces. `Card` defaults here |
| 1 | `--shadow-1` | `0 1px 2px rgba(28, 27, 25, 0.05)` | `0 1px 2px rgba(0, 0, 0, 0.4)` | Panels; buttons; the switch knob. `Panel` defaults here |
| 2 | `--shadow-2` | `0 1px 3px rgba(28, 27, 25, 0.07), 0 4px 12px rgba(28, 27, 25, 0.05)` | `0 1px 3px rgba(0, 0, 0, 0.45), 0 4px 12px rgba(0, 0, 0, 0.35)` | Raised: a hovered interactive card, a slider thumb, a tooltip |
| 3 | `--shadow-3` | `0 2px 8px rgba(28, 27, 25, 0.09), 0 12px 28px rgba(28, 27, 25, 0.1)` | `0 2px 8px rgba(0, 0, 0, 0.5), 0 12px 28px rgba(0, 0, 0, 0.45)` | Menus and popovers; toasts; the skip link |
| 4 | `--shadow-4` | `0 8px 24px rgba(28, 27, 25, 0.12), 0 32px 64px rgba(28, 27, 25, 0.16)` | `0 8px 24px rgba(0, 0, 0, 0.55), 0 32px 64px rgba(0, 0, 0, 0.6)` | Modals: `Dialog`, `Sheet` |

Two supporting tokens:

| Token | Value | For |
| --- | --- | --- |
| `--shadow-focus` | `0 0 0 3px var(--color-accent-subtle)` | The focus halo, always paired with a 1px accent ring |
| `--shadow-inset-hairline` | `inset 0 0 0 1px var(--color-border)` | The hairline edge, drawn as a shadow so it costs no layout |

`PanelElevation` and `ElevationLevel` are both `0 | 1 | 2 | 3 | 4`, and
`tokens.ts` exposes `elevation[level]`, so a level is a design concept and a
shadow is only its rendering.

### 6.2 Depth is a hairline plus a short soft shadow

Each level above 0 is built from two things, in this order:

1. **A hairline** — `inset 0 0 0 1px var(--color-border)`, or
   `--shadow-inset-hairline`. This is what actually separates the surface from
   what is behind it. It is drawn inset so it follows the border radius exactly,
   costs no layout box, and cannot be knocked out of alignment by a sibling's
   margin.
2. **A short, soft shadow** — the level token. Small offsets, large blur, low
   alpha. It says the surface is *slightly* off the one below, not that it is
   floating.

Composed together, in that order:

```css
.mrd-dialog {
  background: var(--color-surface);
  border-radius: var(--radius-2xl);
  box-shadow: inset 0 0 0 1px var(--color-border), var(--shadow-4);
}
```

`Card` composes them through the token:

```css
.mrd-card--elevation-1 { box-shadow: var(--shadow-inset-hairline), var(--shadow-1); }
```

`Panel` takes the other route and uses a real `border: 1px solid var(--color-separator)`,
because a panel also needs `overflow: hidden` to clip its scrolling body to the
rounded corners, and a real border keeps the clip and the edge in the same box.

A hairline with no shadow (level 0) is a complete, correct treatment. Most things
should be level 0 or 1.

### 6.3 Translucency, strictly limited

Two blur tokens exist:

| Token | Value | Applied to |
| --- | --- | --- |
| `--blur-chrome` | `saturate(180%) blur(20px)` | `.mrd-toolbar`, `.mrd-sidebar` |
| `--blur-overlay` | `saturate(160%) blur(32px)` | `.mrd-popover`, `.mrd-tooltip` |

That is the whole list. Translucency is for **chrome and transient surfaces**:
things whose job includes telling you what is behind them. It is never used on a
content surface. A translucent panel means the data inside it is being read
against whatever happens to be underneath, which changes as the user scrolls.

Both blurred surfaces pair the blur with a translucent background token
(`--color-toolbar`, `--color-sidebar`, `--color-overlay`) and a saturation boost,
because a plain blur desaturates what it samples and the chrome ends up looking
grey against a colourful background.

Modals are opaque. `Dialog` uses `--color-surface`, `Sheet` uses `--color-panel`.
A modal that lets its background through is a modal that fails at the one thing
it is for.

There is a fallback, and it is not "blur off":

```css
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .mrd-toolbar,
  .mrd-sidebar {
    background: var(--color-surface);
  }
}
```

Translucency without blur is illegible over scrolling content, so a browser that
cannot blur gets opaque chrome instead. If you add a translucent surface, add its
fallback in the same commit.

---

## 7. Iconography

There is no shared icon module yet. Glyphs are private components defined in the
file that uses them: `Data.tsx`, `Form.tsx`, `Controls.tsx` and `Overlay.tsx`
each declare their own. The rules below are what those glyphs already follow and
what a shared module must preserve.

### 7.1 One grid

Every glyph is drawn on a **16×16 `viewBox`**, with two deliberate exceptions:

- `StatusGlyph` in `Controls.tsx` uses `0 0 12 12`, because status marks render
  at chip scale and a 16-grid shape scaled to 12px loses its silhouette.
- `Star` in `Controls.tsx` uses `0 0 24 24`, because it is a single imported
  path shape rather than a member of the family.

Glyphs carry **no width or height attributes**. They are sized by their
container, which is what lets one `<CheckGlyph />` sit correctly in a 13px
`sm` button and a 16px icon button without a variant.

```tsx
/** Glyphs are sized by their container, so they carry no dimensions of their own. */
function CheckGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none">
      <path d="M3.5 8.4 6.4 11.3 12.5 5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
```

### 7.2 One stroke treatment

`fill="none"`, `stroke="currentColor"`, round caps and joins. Colour comes from
the parent, so a glyph inherits selection, hover, destructive and disabled
treatment for free and never needs a colour prop.

Stroke weight on the 16-grid runs 1.4–1.9, chosen against the shape's own density:
`Overlay.tsx` has a shared wrapper that fixes it at 1.5, `Form.tsx` uses 1.5 for
outlines and 1.6 for chevrons, and `Data.tsx` uses 1.9 for the check, cross and
dash, which are single short strokes and would otherwise read lighter than the
outlined glyphs beside them. The rule is optical weight, not a constant number —
but a new glyph should match the file it lands in rather than introducing a
sixth value.

The shared wrapper is the pattern worth copying:

```tsx
function Glyph({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}
```

### 7.3 Rendered sizes

The container sets the size, in CSS, from a small set:

| Rendered size | Where |
| --- | --- |
| 13px | `sm` buttons, `sm` icon buttons, `sm` inputs, `sm` list rows, chevrons, the search clear button |
| 15px | Default: button icons, input icons, segmented and tab icons, toast icons |
| 16px | Icon buttons at default size; sidebar items |
| 18px | `lg` icon buttons |

Three sizes carry the family — 13 for dense, 15 inline with text, 16 for
standalone controls — with 18 for the large icon button. A handful of one-off
sizes exist where the container's own scale governs: the table sort glyph at
11px, the menu item's leading glyph at 14px, the timeline indicator at
`var(--space-3)`, the empty-state icon at `var(--space-5)`, and the avatar's
fallback glyph at `60%` of the avatar.

Decorative glyphs are marked `aria-hidden="true"` and, where they sit inside a
control that could receive focus, `focusable="false"`. An icon that carries
meaning gets a text equivalent instead — `IconButton` makes `label` required for
exactly this reason.

---

## 8. Components

Everything below exists today. Paths are relative to `packages/ui/src/`.

### 8.1 Primitives — `primitives/Button.tsx`

| Export | Purpose |
| --- | --- |
| `Button` | The four roles and only four: `primary`, `secondary` (default), `tertiary`, `destructive`; sizes `sm` / `md` / `lg`; `icon`, `trailingIcon`, `loading`, `fullWidth` |
| `IconButton` | Icon-only control. `label` is required — an icon-only control is unusable to a screen reader without it. Supports `pressed` for toggles |
| `ButtonGroup` | Joins buttons into one control, or spaces them with `spaced` |

### 8.2 Primitives — `primitives/Form.tsx`

| Export | Purpose |
| --- | --- |
| `Input` | Text field in the three control heights, with `icon`, `adornment`, `invalid`, `description`, `error` |
| `TextArea` | Multi-line field |
| `SearchField` | Search with a clear affordance that exists only when there is something to clear, and Escape to empty |
| `Select` | A native `<select>` in Meridian's clothes — native keeps type-ahead, the platform keyboard model and the system picker on touch |
| `Checkbox` | A real `<input type="checkbox">` behind a drawn one; supports `indeterminate` |
| `Radio` / `RadioGroup` | The group owns the selection so radios never flip between controlled and uncontrolled |
| `Switch` | `role="switch"`; the knob's position, not the track's colour, reports the state |
| `Slider` | Range input with a value readout |
| `Field` | Label above, control, then help or error. An error here also marks the control invalid |
| `FormRow` | Settings row: text left, control right, hairline between consecutive rows |
| `DisclosureRow` | A settings row that opens to reveal detail; the panel is `hidden` while closed so its controls leave the tab order |
| `Fieldset` | Related rows in one card, as a real `<fieldset>` so the title names the group |

Controls placed inside `Field` or `FormRow` read their id, label id, description
id and invalid state from context and must not re-wire them.

### 8.3 Primitives — `primitives/Controls.tsx`

| Export | Purpose |
| --- | --- |
| `SegmentedControl` | Two to five exclusive choices in one control, with a pill that travels to the selection. A `radiogroup`, so the whole control is one tab stop |
| `Tabs`, `TabList`, `Tab`, `TabPanel` | `underline` or `pill` variant, horizontal or vertical |
| `Kbd` | A keycap for a shortcut hint; splits a combo into per-key caps where the platform convention has separate keys |
| `Badge` | `neutral` / `accent` / `success` / `warning` / `error`; `count` caps at `max` for the eye while the real count is announced |
| `StatusChip` | The eight `Status` values, each with its own silhouette |
| `Progress` | Determinate or indeterminate bar; requires `label` or `labelledBy` |
| `Meter` | A measured value against a range, with a tabular readout |
| `Avatar` | Initials or image, with a stable per-name tint |
| `Skeleton` | `text` / `line` / `block` / `circle` placeholders |
| `Stars` | A rating |

### 8.4 Primitives — `primitives/Overlay.tsx`

| Export | Purpose |
| --- | --- |
| `Popover` | A floating surface tied to an anchor, portalled to `<body>` so no ancestor's overflow, transform or stacking context can clip it |
| `Menu`, `MenuItem`, `MenuSeparator`, `MenuGroup` | A desktop application menu with roving focus over real items |
| `Tooltip` | A description attached to its trigger; clones the child so `aria-describedby` lands on the control the user focuses |
| `Dialog` | A modal question or task: focus trap, focus restore, scroll lock, Escape, accessible name |
| `Sheet` | An edge-anchored modal panel (`right` or `bottom`) with exactly the `Dialog` guarantees |
| `Toast`, `ToastProvider`, `useToast` | Notifications with a pausable countdown |
| `ContextMenu` | A menu at the pointer; also opens on the context-menu key and Shift+F10 |

The overlay stack is managed centrally: each layer takes the greater of its own
`z` token and one step above the current top of the stack, so a menu opened
inside a dialog paints above it despite `--z-dropdown` being below `--z-modal`.
Escapable layers form a chain where only the topmost answers the key.

### 8.5 Layouts — `layouts/Layout.tsx`

| Export | Purpose |
| --- | --- |
| `Panel`, `PanelHeader`, `PanelBody` | The level-1 region surface. A flex column, so the body takes the remaining height and scrolls while header and footer stay put. `title` also names the region for landmark navigation |
| `Card` | A lighter grouping surface for repeated things. Adding `onClick` makes it a control with a role, tab stop, keyboard activation and hover lift |
| `Toolbar`, `ToolbarGroup`, `ToolbarSeparator` | The translucent top chrome. Deliberately not `role="toolbar"` — that role promises roving arrow navigation a mixed bar cannot honour |
| `Sidebar`, `SidebarSection`, `SidebarItem` | The navigation column, with a collapsed mode that folds labels into accessible names |
| `SplitPane` | Resizable panes sized in fractions, applied as `flex-grow` |
| `StatusBar` | The bottom strip. Not a live region: it holds standing facts |
| `EmptyState` | What a region says when it has nothing to show; ends in an action |
| `Inspector` | The right-hand properties column, fixed by `--inspector-width` so the centre column is the one that flexes |
| `Stack` | Flex row or column with a gap taken from the space scale by index |

### 8.6 Components — `components/Data.tsx`

| Export | Purpose |
| --- | --- |
| `List`, `ListRow` | The dense list. The whole list is one tab stop; arrows move within it |
| `Table` | The generic table: sticky header, sortable columns, optional row selection, loading skeletons, empty slot. Owns its horizontal overflow |
| `Timeline`, `TimelineStep` | The agent task timeline, as an ordered list because the order is the meaning |
| `KeyValue` | The metadata definition list, with per-item copy buttons that appear on hover or focus |

### 8.7 Utilities — `primitives/util.ts`

| Export | Purpose |
| --- | --- |
| `cx` | Join class names, dropping anything falsy |
| `isApplePlatform` | Platform detection for shortcut display |
| `formatShortcut` | `"mod+k"` → `⌘K` or `Ctrl+K` |
| `matchesShortcut` | Match a `KeyboardEvent` against a `"mod+k"`-style combo |

### 8.8 Base utilities — `tokens/base.css`

| Class | Purpose |
| --- | --- |
| `.mrd-display` … `.mrd-code` | The type scale (see [3.2](#32-the-scale)) |
| `.mrd-numeric` | Tabular figures |
| `.mrd-truncate` | Single-line ellipsis, with `min-width: 0` so it works inside flex |
| `.mrd-clamp-2` | Two-line clamp |
| `.mrd-sr-only` | Visible to screen readers, invisible on screen |
| `.mrd-skip-link` | A skip link that slides in when focused |
| `.mrd-focus-ring` | Opt out of the global outline and draw the halo ring instead |
| `.mrd-surface` | Surface background, separator hairline, `--radius-xl` |
| `.mrd-scroll`, `.mrd-scroll-x` | Scroll regions with `overscroll-behavior: contain` |
| `.mrd-overflow-guard` | Wide content scrolls inside its own box |
| `.mrd-hstack`, `.mrd-vstack`, `.mrd-spacer` | Flex helpers that release the min-size default |
| `.mrd-resizer` | A drag handle whose hit area is wider than its visible line |

---

## 9. States

### 9.1 The state rule

**A state lives on a `data-` or `aria-` attribute. It is never a class.**

Classes describe what a thing *is* — `mrd-button--primary`, `mrd-panel--elevation-1`,
`mrd-list--sm`. Attributes describe what it is *doing right now*.

The reason is that most states must exist in the accessibility tree anyway.
Selection has to be `aria-selected` or `aria-current` for a screen reader to
report it. If the styling hangs off a separate `.is-selected` class, there are
now two sources of truth that can disagree, and the one that breaks silently is
the one nobody can see. `Layout.css` states it directly:

```css
/* Selection is carried by aria-current, so the styling hangs off it rather than
   off a class: the two can never drift apart. */
.mrd-sidebar-item[aria-current='page'] { … }
```

Where an ARIA attribute exists for the state, style from it. Where none does,
use a `data-` attribute set from the same value that drives the ARIA one.

Attributes in use: `data-selected`, `data-disabled`, `data-invalid`,
`data-loading`, `data-pressed`, `data-status`, `data-indeterminate`,
`data-collapsed`, `data-open`, `data-placement`, `data-orientation`,
`data-copied`, `data-dragging`, `data-positioned`, `data-tone`, `data-align`,
`data-justify`, `data-last`; and `aria-selected`, `aria-current="page"`,
`aria-checked`, `aria-sort`.

### 9.2 How each state is expressed

**Default.** The resting treatment. Tertiary controls are transparent with
`--color-text-secondary`; secondary controls are `--color-surface` with a
`--color-border` hairline.

**Hover.** A neutral fill one step up: `--color-fill-quiet` → `--color-fill-hover`.
Tertiary controls also promote their text from secondary to primary, which is
what makes a quiet control feel like it woke up. Interactive cards add a 1px
lift and go from level 0 to level 2. Hover never changes layout.

**Active (pressed).** The next fill step, `--color-fill-active`, plus a small
travel. `Button` moves down 0.5px; `Card` returns to `translateY(0)` from its
hover lift and drops back to level 1. The travel is deliberately sub-pixel-small:

```css
/* A 1px press travel. Enough to feel like the control moved under the finger,
   small enough that a row of buttons does not appear to jitter. */
.mrd-button:active:not(:disabled) { transform: translateY(0.5px); }
```

**Focus.** Two mechanisms. The global one, in `base.css`:

```css
:focus { outline: none; }
:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
  border-radius: var(--radius-sm);
}
```

And the opt-in ring for elements that draw their own, which follows the
element's own radius and never shifts layout because it is a shadow:

```css
.mrd-focus-ring:focus-visible {
  outline: none;
  box-shadow: var(--shadow-focus), 0 0 0 1px var(--color-accent);
}
```

Text fields are the exception: `.mrd-input:focus-within` — not `:focus-visible` —
because the ring on a text field is what says where typing will land, and that
answer matters to pointer users too.

**Selected.** `--color-accent-subtle`, moving to `--color-accent-subtle-hover`
on hover so a selected row still responds to the pointer. A selected surface
adds `--color-accent-border` as its hairline. Icons inside a selected row take
`--color-accent`.

```css
.mrd-list__row[data-selected]        { background: var(--color-accent-subtle); }
.mrd-list__row[data-selected]:hover  { background: var(--color-accent-subtle-hover); }
.mrd-card[data-selected='true'] {
  background: var(--color-accent-subtle);
  box-shadow: inset 0 0 0 1px var(--color-accent-border), var(--shadow-1);
}
```

**Disabled.** `opacity: 0.42` (0.4 on icon buttons and menu items) plus
`cursor: not-allowed`; menu items use `cursor: default`. Opacity rather than a
grey token, so the control keeps its shape and its relationship to its neighbours and is still recognisable as the
thing it was. Disabled rows stay in the roving keyboard order and carry
`aria-disabled` rather than being removed — hiding a row from the keyboard hides
that it exists, which is worse than landing on something that cannot be acted on.

**Loading.** `Button` sets `data-loading`, `aria-busy` and `disabled` together,
and swaps the leading icon for a spinner **without changing the button's width**,
so a row of controls does not reflow when one starts working. `Table` takes
`loading` and `skeletonRows` and renders `Skeleton` rows in place of data.

**Error.** The field's box takes a `--color-error` inset hairline via
`data-invalid`; the control gets `aria-invalid`; and the message renders with
`role="alert"` and a glyph beside it, so the failure is legible to someone who
cannot separate red from grey:

```css
.mrd-input[data-invalid]              { box-shadow: inset 0 0 0 1px var(--color-error); }
.mrd-input[data-invalid]:focus-within { box-shadow: inset 0 0 0 1px var(--color-error), var(--shadow-focus); }
```

An `error` passed to `Field` also marks the control invalid through context, so
the ring and the message can never disagree.

---

## 10. Motion

### 10.1 The tokens

| Token | Value | Use |
| --- | --- | --- |
| `--duration-instant` | 80ms | Press travel; anything that must feel like a direct consequence of the finger |
| `--duration-fast` | 130ms | The default. Hover, focus, colour and shadow changes on controls |
| `--duration-base` | 190ms | Something moving or arriving: sidebar collapse, dialog entry, toast entry |
| `--duration-slow` | 280ms | The longest sanctioned transition |

| Token | Value | Use |
| --- | --- | --- |
| `--ease-out` | `cubic-bezier(0.32, 0.72, 0, 1)` | Anything the user initiated. Decisive: quick to commit, gentle to settle |
| `--ease-in-out` | `cubic-bezier(0.65, 0, 0.35, 1)` | Things arriving without user action, so they do not snap; also the status pulse and the indeterminate sweep |
| `--ease-linear` | `linear` | Continuous loops only — the spinner and the skeleton shimmer |

The distribution in the stylesheets reflects the intent: `--duration-fast` and
`--ease-out` account for the large majority of every transition in the product.

### 10.2 What motion is for

- **Something moved.** The segmented control's pill is a single element driven by
  measured geometry, so a change of selection reads as one thing travelling.
  Cross-fading a background on each segment instead would lose that.
- **Something arrived.** A popover rises from the corner nearest its anchor
  (`transform-origin` is set per placement) so a flip reads as the same panel
  moving rather than a different one appearing. A dialog enters at `scale(0.98)`.
  A toast enters from `translateY(var(--space-2))`.
- **A control changed state.** Background, border and shadow transitions at
  `--duration-fast`.
- **Progress is real.** The indeterminate bar sweeps because the only honest
  thing an indeterminate bar can say is "still working".

### 10.3 What motion is never for

- **Decoration.** No entrance animation on content that was always going to be
  there. No parallax. No hover animations that exist to be noticed.
- **Layout.** Nothing animates `width`, `height`, `top` or `left` except the
  sidebar's `width`, which is a deliberate direct-manipulation affordance and is
  paired with `overflow: hidden` so labels do not spill while it runs.
- **Delay.** Motion never sits between an action and its result. Interaction
  timings that *are* delays — the 400ms tooltip delay, the 700ms typeahead reset,
  the 6000ms toast lifetime, the 1400ms copy confirmation — are plain constants in
  `Overlay.tsx` and `Data.tsx`, deliberately outside the duration scale, because
  the duration scale exists to be collapsed by reduced motion and a tooltip delay
  must not collapse with it.

### 10.4 Reduced motion

Two switches, both collapsing the durations to 1ms:

```css
@media (prefers-reduced-motion: reduce) { :root { --duration-instant: 1ms; … } }
:root[data-reduce-motion='true']        { --duration-instant: 1ms; … }
```

1ms, not 0. A zero-duration transition may not fire `transitionend`, and a state
machine waiting on that event would stall.

Looping animations are handled individually, because collapsing them is wrong in
both directions:

| Loop | Under reduced motion | Why |
| --- | --- | --- |
| Button spinner | 620ms → 2.4s | Slowed, not stopped: a still spinner claims the work stalled |
| Indeterminate progress | 1500ms → 4s, `--ease-linear` | Same reason |
| Status "busy" pulse | Stopped | The half-dot silhouette already distinguishes busy, so nothing is lost |
| Skeleton shimmer | Stopped, gradient removed, flat tint | The travelling highlight is exactly the ambient motion reduced-motion asks for less of |
| Table skeleton / timeline dot breathe | Stopped | The placeholder and the filled-dot-among-rings already say what they say |

Both switches must be handled. `prefers-reduced-motion` covers the OS setting;
`[data-reduce-motion='true']` covers the in-app preference, for users who want it
in this app and not everywhere.

---

## 11. Light and dark mode

### 11.1 The three-state contract

| State | Root markup | Which rules apply |
| --- | --- | --- |
| System (default) | no `data-theme` attribute | Bare `:root` gives light. `@media (prefers-color-scheme: dark) :root:not([data-theme='light'])` overrides to dark when the OS says dark |
| Explicit light | `<html data-theme="light">` | Bare `:root`. The media block is excluded by its own `:not([data-theme='light'])` guard, so an OS in dark mode cannot override the user's choice |
| Explicit dark | `<html data-theme="dark">` | `:root[data-theme='dark']`, which applies regardless of the OS setting |

This is why the dark palette is written twice — once inside the guarded media
query, once in `:root[data-theme='dark']`. The duplication is the price of an
explicit choice winning in **both** directions. Two blocks, one set of values;
they must be edited together.

Each theme also sets `color-scheme` (`light` on `:root`, `dark` in both dark
blocks), which is what makes native form controls, scrollbars and the canvas
behind the page match.

### 11.2 How a component declares colours

Three rules, and they are absolute:

1. **Every colour is a token reference.** No hex, no `rgb()`, no named colour in
   a component stylesheet.
2. **Every colour is declared once, in the theme-neutral rule.** A component
   never has a `@media (prefers-color-scheme: dark)` block of its own and never
   has a `[data-theme]` selector of its own. If a colour needs to differ by
   theme, that difference belongs in `tokens.css`, expressed as a token.
3. **The token names carry the meaning, not the value.** Use
   `--color-text-secondary`, not "the grey one". Semantic names are what let the
   dark palette be a different set of values rather than a mirror.

Correct:

```css
.mrd-trace-row {
  background: var(--color-surface);
  color: var(--color-text-primary);
  border-bottom: 1px solid var(--color-separator);
}
.mrd-trace-row:hover        { background: var(--color-fill-hover); }
.mrd-trace-row[data-selected] { background: var(--color-accent-subtle); }
```

Wrong:

```css
.mrd-trace-row {
  background: #fff;                       /* cannot follow an explicit theme choice */
  color: #1c1b19;                          /* freezes the light text colour into dark mode */
  border-bottom: 1px solid #eee;           /* ignores prefers-contrast: more entirely */
}
@media (prefers-color-scheme: dark) {      /* an OS-only override; the in-app toggle cannot reach it */
  .mrd-trace-row { background: #1e1e20; color: #f0efed; }
}
```

The fourth line is the one that catches people. A component-level
`prefers-color-scheme` block responds to the operating system and nothing else,
so a user who has explicitly chosen light while their OS is dark gets a light
shell with dark rows in it.

### 11.3 The two exceptions in the codebase

`Button.css` contains the only two literal colours in the component layer:

```css
.mrd-button--primary { box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.06), var(--shadow-1); }
.mrd-button--destructive:hover:not(:disabled) { background: var(--color-error); color: #fff; }
```

The first is a darkening overlay on top of an accent fill rather than a colour in
its own right; the second is white on a saturated error fill in both themes, and
`--color-text-on-accent` is `#ffffff` in both. Neither is a licence to add more.
New code uses tokens.

---

## 12. Accessibility

### 12.1 Contrast

The text ramp is built for contrast, not for a pleasing grey. Primary text is
`#1c1b19` on `#ffffff`; secondary is `#6a6862`, which is chosen to stay readable
as supporting text rather than to be the lightest grey that still "works".
Tertiary (`#9c9992`) is for metadata and placeholders, never for anything a user
must read to complete a task.

`prefers-contrast: more` raises hairline and secondary-text contrast without
changing hue, so the interface stays recognisably itself:

| Token | Normal (light) | High contrast (light) | Normal (dark) | High contrast (dark) |
| --- | --- | --- | --- | --- |
| `--color-separator` | `rgba(28, 27, 25, 0.07)` | `rgba(28, 27, 25, 0.2)` | `rgba(255, 255, 255, 0.07)` | `rgba(255, 255, 255, 0.2)` |
| `--color-border` | `rgba(28, 27, 25, 0.12)` | `rgba(28, 27, 25, 0.32)` | `rgba(255, 255, 255, 0.11)` | `rgba(255, 255, 255, 0.32)` |
| `--color-border-strong` | `rgba(28, 27, 25, 0.2)` | `rgba(28, 27, 25, 0.5)` | `rgba(255, 255, 255, 0.2)` | `rgba(255, 255, 255, 0.5)` |
| `--color-text-secondary` | `#6a6862` | `#4a4844` | `#9e9c97` | `#c9c7c2` |
| `--color-text-tertiary` | `#9c9992` | `#6a6862` | `#6e6c68` | `#a3a19c` |

Because every component reads these tokens, high-contrast support is automatic
for anything built correctly — and unreachable for anything that hard-codes a
colour.

### 12.2 Focus

Focus is always visible for keyboard users. `base.css` removes the default
outline only from `:focus` and immediately restores a 2px accent outline at
`:focus-visible`. An interface that hides focus is unusable without a mouse.

Components that need the ring to follow their own radius add `.mrd-focus-ring`.
Both mechanisms use the accent, so focus is recognisable anywhere in the product.

Focus is **moved and restored**, not left where it fell. `Dialog` and `Sheet`
move focus into the panel on open and give it back on close — conditionally: if
focus has already landed somewhere else because the user clicked another control
to dismiss the overlay, taking it back would be a hijack.

### 12.3 Keyboard

| Pattern | Where |
| --- | --- |
| Roving tabindex — the group is one tab stop, arrows move within it | `List`, `Table` (when selectable), `Menu`, `SegmentedControl`, `Tabs` |
| Movement clamps at the ends rather than wrapping | `List`, `Table` — a list that jumps from the last row back to the first hides the fact that you reached the bottom |
| Enter and Space activate | `ListRow`, `Card` when interactive — neither is a native button, so activation is wired explicitly and Space is `preventDefault`ed so it does not scroll |
| Escape dismisses the topmost layer only | The overlay Escape chain, so closing a menu inside a dialog does not also close the dialog |
| Tab and Shift+Tab cycle inside a modal | `Dialog`, `Sheet` |
| Context menus open from the keyboard | `ContextMenu` responds to the context-menu key and Shift+F10 — a context menu reachable only by right-click is one a keyboard user does not have |
| Shortcuts render per platform | `formatShortcut` gives `⌘K` on Apple platforms and `Ctrl+K` elsewhere; `MenuItem` also emits `aria-keyshortcuts` in named-key form |

Keys pressed while focus is on a control *inside* a row are left alone, so a
trailing menu button inside a list row keeps its own keyboard behaviour.

### 12.4 Screen readers

- Regions are named. `Panel` with a `title` gets `aria-labelledby`; `Toolbar`,
  `Sidebar` and `StatusBar` take a `label`; an unnamed region is invisible to
  anyone navigating by landmark.
- Icon-only controls require a name. `IconButton`'s `label` prop is required, not
  optional.
- Composite widgets require a name. `List` when selectable, `Progress`,
  `SegmentedControl` and a `role="dialog"` `Popover` all take `label` or
  `labelledBy`, because a `listbox`, `progressbar`, `radiogroup` or `dialog`
  with no accessible name announces as an unlabelled one.
- `.mrd-sr-only` carries what the visual design drops. `Badge` shows `99+` to the
  eye and announces the real count. `StatusChip` announces the canonical status
  even when it displays a custom label. The copy button announces its
  confirmation through a `role="status"` region, because a swapped glyph is
  invisible to a screen reader and a renamed button is not announced on its own.
- Live regions are used sparingly and deliberately. `StatusBar` is **not** a live
  region — it holds standing facts, and announcing every change to a token
  counter would make the app unusable with a screen reader. The toast viewport is
  mounted for the life of the app rather than with the first toast, because a
  live region inserted at the same moment as its content is not reliably
  announced. `EmptyState` takes an opt-in `live` prop for the case where it
  replaces results after a filter.
- The heading outline is not invented. `PanelHeader` takes `headingLevel`, and
  `EmptyState` renders a `<p>` unless you pass one — an invented level would
  corrupt the outline.
- `.mrd-skip-link` gives a keyboard user a way past the chrome; it is off-screen
  until focused.

### 12.5 Reduced motion and high contrast

Covered in [10.4](#104-reduced-motion) and [12.1](#121-contrast). Both are
handled in `tokens.css` and inherited by every component that uses tokens; the
per-component work is limited to looping animations, which each declare their own
reduced-motion behaviour.

### 12.6 Colour independence

**Status is never carried by colour alone.** Roughly a tenth of users cannot
separate the success green from the warning amber, and a screenshot pasted into a
ticket loses hue entirely.

| Component | The non-colour carrier |
| --- | --- |
| `StatusChip` | A distinct silhouette per status: a filled dot (ready), a ringed dot (healthy), a half-filled ring (busy), a ring with a bar (rate limited), a filled triangle (degraded), a struck-through ring (offline), an empty ring (unknown), a cross (error) |
| `TimelineStep` | An empty ring, a live dot, a check, a cross, a dash — so the run reads correctly in greyscale |
| `Switch` | The knob's position, not the track's colour |
| Field errors | A glyph beside the message, plus `role="alert"` |
| `SidebarItem` | A dot glyph when collapsed, so pending work is still visible without relying on the badge's colour |
| `Table` sorting | `aria-sort` plus a direction glyph |

When you add a status, add its shape. A ninth `Status` value that is only a
recoloured dot is an incomplete implementation.

---

## 13. Extending the system

### 13.1 Adding a token

1. Decide whether it is genuinely new. Most needs are met by an existing semantic
   token used correctly. A second grey for secondary text is not a new token; it
   is a misuse of `--color-text-secondary`.
2. Name it for its **role**, not its value or its first use:
   `--color-trace-span`, not `--color-blue-6` and not `--color-timeline-bar`.
3. Add the light value to bare `:root` in `tokens.css`, in the group it belongs
   to, with a comment saying why the value is what it is.
4. If it needs a dark value, add it to **both** dark blocks — the guarded media
   query and `:root[data-theme='dark']`. Missing one produces a theme that is
   correct on the OS setting and wrong on the explicit toggle, or the reverse.
5. If TypeScript needs to reference it, mirror it in `tokens.ts` as a `var()`
   string. `tokens.ts` is a mirror, never a second source of truth.
6. If it is a hairline or a text colour, consider whether the
   `prefers-contrast: more` block needs it too.

```css
/* tokens.css — :root */
/* The highlight behind a selected span in the trace view. Lighter than the
   accent selection so a selected row and a selected span stay distinguishable. */
--color-trace-span: rgba(47, 106, 232, 0.18);

/* tokens.css — @media (prefers-color-scheme: dark) > :root:not([data-theme='light']) */
--color-trace-span: rgba(91, 141, 255, 0.24);

/* tokens.css — :root[data-theme='dark'] */
--color-trace-span: rgba(91, 141, 255, 0.24);
```

```ts
// tokens.ts
export const color = {
  // …
  traceSpan: 'var(--color-trace-span)',
} as const;
```

### 13.2 Adding a component

Place it by role: `primitives/` for controls, `layouts/` for shell surfaces,
`components/` for data display. Each `.tsx` has a sibling `.css` with the same
name.

The house style, all of which `Button.tsx` demonstrates:

- `forwardRef` to the underlying element, so a caller can measure it, focus it or
  anchor a popover to it.
- Extend the native props type and spread `...rest`, minus anything you redefine.
- Compose class names with `cx`; variant and size as `mrd-block--modifier`.
- Add `mrd-focus-ring` if the element draws its own ring.
- Put state on `data-`/`aria-` attributes.
- Give every prop that is not obvious a one-line doc comment explaining the
  decision, not the mechanics.
- Colours, spacing, radii, shadows and durations come from tokens.

Here is a complete, correct component:

```tsx
// components/RouteRow.tsx
import { forwardRef } from 'react';
import { StatusChip, type Status } from '../primitives/Controls.js';
import { cx } from '../primitives/util.js';

export interface RouteRowProps {
  name: string;
  status: Status;
  /** Pre-formatted, e.g. "142 ms". Rendered with tabular figures. */
  latency: string;
  selected?: boolean;
  onSelect?: () => void;
}

export const RouteRow = forwardRef<HTMLButtonElement, RouteRowProps>(function RouteRow(
  { name, status, latency, selected = false, onSelect },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cx('mrd-route-row', 'mrd-focus-ring')}
      data-selected={selected || undefined}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="mrd-route-row__name mrd-truncate">{name}</span>
      <StatusChip status={status} size="sm" />
      <span className="mrd-route-row__latency mrd-numeric mrd-secondary">{latency}</span>
    </button>
  );
});
```

```css
/* components/RouteRow.css */
.mrd-route-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
  height: var(--row-height);
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--color-text-primary);
  transition: background-color var(--duration-fast) var(--ease-out);
}

.mrd-route-row:hover  { background: var(--color-fill-hover); }
.mrd-route-row:active { background: var(--color-fill-active); }

.mrd-route-row[data-selected]       { background: var(--color-accent-subtle); }
.mrd-route-row[data-selected]:hover { background: var(--color-accent-subtle-hover); }

.mrd-route-row__latency { margin-left: auto; }
```

And the same component written incorrectly, line by line:

```tsx
export function RouteRow({ name, status, latency, selected, onSelect }: RouteRowProps) {
  return (
    <div
      className={selected ? 'route-row is-selected' : 'route-row'}
      onClick={onSelect}
      style={{ padding: '7px 10px', fontSize: 14 }}
    >
      <span style={{ color: '#6a6862' }}>{name}</span>
      <span className={`dot dot--${status}`} />
      <span>{latency}</span>
    </div>
  );
}
```

| Line | What is wrong |
| --- | --- |
| `<div … onClick>` | Not focusable, not activatable by keyboard, no role. A control has to be a `<button>` or carry a role, a tab stop and Enter/Space handling — see how `Card` does it |
| no `forwardRef` | A caller cannot focus it, scroll it into view, or anchor a popover to it |
| `'route-row'` | Missing the `mrd-` prefix; will collide |
| `'is-selected'` | State as a class. Selection must be an attribute the accessibility tree also reads — here, nothing tells a screen reader the row is selected at all |
| `style={{ padding: '7px 10px' }}` | Off the space scale twice over, and inline, so it cannot be overridden or retuned |
| `fontSize: 14` | Off the type scale; 13px is body, 14px is the reading step and this is not reading text |
| `color: '#6a6862'` | A literal colour. Frozen in the light palette; invisible in dark mode; ignores `prefers-contrast: more` |
| `dot dot--${status}` | A recoloured dot. Status must carry its own silhouette, and the state must be announced |
| `latency` with no `.mrd-numeric` | A live number in proportional figures: the column jitters on every update and will not align |
| no transition | Hover and selection snap. Everything else in the product moves at `--duration-fast var(--ease-out)` |
| no `mrd-focus-ring` | Even once it is focusable, it will fall back to the global outline, which will not follow its radius |

### 13.3 Adding a screen

A screen is composed, not designed from scratch.

1. **Choose the shell.** `Toolbar` at the top, `Sidebar` on the left, `Inspector`
   on the right, `StatusBar` at the bottom, `SplitPane` for anything resizable.
   The document itself never scrolls — `base.css` sets `overflow: hidden` on
   `body`, and a workstation shell owns its own scrolling.
2. **Divide into `Panel`s.** One per region that scrolls, acts or is positioned
   independently. Give each a `title` so it is named for landmark navigation, and
   a `headingLevel` that matches the surrounding outline.
3. **Fill with the data components.** `List` for a dense navigable list, `Table`
   for a comparable result set, `KeyValue` for metadata, `Timeline` for an
   ordered run. Give `Table` a bounded height, or its sticky header has nothing
   to stick to.
4. **Design the empty state before the full one.** Most regions of a gateway are
   empty on first run. `EmptyState` ends in an action, so an empty panel is a
   starting point rather than a dead end.
5. **Design the loading state.** `Table` takes `loading` and `skeletonRows`;
   elsewhere use `Skeleton`. A spinner in the middle of a region is a last resort.
6. **Spend the accent once.** One primary button per view. If two actions both
   feel primary, one of them is not.
7. **Wire the shortcuts.** `matchesShortcut` for handling, `Kbd` or `MenuItem`'s
   `shortcut` prop for display, so the hint and the handler use the same string.

### 13.4 Review checklist

A change to the interface layer should be able to answer yes to all of these.

**Tokens**
- [ ] No literal colour anywhere in the diff.
- [ ] Every spacing value is a `--space-*` token or a `calc()` over them.
- [ ] Every radius is a `--radius-*` token, and it matches the element's class
      (control / surface / overlay / pill).
- [ ] Every shadow is a `--shadow-*` token; depth is a hairline plus a level.
- [ ] Every duration and easing is a token.
- [ ] Any new token is defined in `:root` **and** in both dark blocks.

**Typography**
- [ ] Hierarchy comes from the type scale before it comes from a box.
- [ ] Every number that changes or is compared down a column has `.mrd-numeric`.
- [ ] Uppercase appears only as `.mrd-panel-title`.
- [ ] Text that can overflow has `.mrd-truncate` and a parent that allows it to
      shrink (`min-width: 0`).

**State**
- [ ] Every state is a `data-` or `aria-` attribute, not a class.
- [ ] Where an ARIA attribute exists for the state, the CSS styles from it.
- [ ] Hover, active, focus, selected and disabled are all defined.
- [ ] Nothing changes layout on hover.

**Accessibility**
- [ ] Focus is visible, follows the element's radius, and shifts no layout.
- [ ] Every interactive element is reachable and operable by keyboard.
- [ ] Every icon-only control has a name; every composite widget has a name;
      every region has a name.
- [ ] Status is legible in greyscale.
- [ ] Decorative glyphs are `aria-hidden`.
- [ ] Any new looping animation declares its reduced-motion behaviour under both
      `prefers-reduced-motion` and `[data-reduce-motion='true']`.

**Theming**
- [ ] The component has no `prefers-color-scheme` or `[data-theme]` selector of
      its own.
- [ ] It has been looked at in explicit light, explicit dark, and system dark.

**Composition**
- [ ] Every new surface is justified: is it a region (`Panel`), a repeated item
      (`Card`), or neither?
- [ ] The accent appears only for selection, focus, the one primary action, or
      status.
- [ ] Wide content scrolls inside its own box; the shell never scrolls sideways.

---

## Appendix A: Layout and geometry tokens

| Token | Value | For |
| --- | --- | --- |
| `--toolbar-height` | 44px | Top chrome; also the minimum height of a panel header and footer |
| `--statusbar-height` | 26px | Bottom strip |
| `--sidebar-width` | 216px | Navigation column, expanded |
| `--sidebar-width-collapsed` | 52px | Navigation column, collapsed to icons |
| `--inspector-width` | 340px | Right-hand properties column; also the base for popover max-width and the three dialog sizes |
| `--drawer-height` | 260px | Declared for a bottom drawer; not yet consumed |
| `--control-height-sm` | 22px | `sm` buttons, inputs, icon buttons; status chips |
| `--control-height` | 28px | Default control height |
| `--control-height-lg` | 34px | `lg` controls; avatars; circular skeletons |
| `--row-height` | 26px | The dense list and table row |

Dialog widths are derived rather than invented, so a dialog reads as one,
one-and-a-half or two panels wide and stays in proportion with the panes it
opens over:

```css
.mrd-dialog--sm { max-width: var(--inspector-width); }                                  /* 340px */
.mrd-dialog--md { max-width: calc(var(--inspector-width) + var(--space-11) * 2); }      /* 500px */
.mrd-dialog--lg { max-width: calc(var(--inspector-width) * 2); }                        /* 680px */
```

## Appendix B: Stacking

| Token | Value | Layer |
| --- | --- | --- |
| `--z-base` | 0 | Content |
| `--z-sticky` | 10 | Sticky table headers |
| `--z-toolbar` | 20 | Top chrome |
| `--z-dropdown` | 40 | Dropdowns |
| `--z-popover` | 50 | Popovers and menus |
| `--z-tooltip` | 60 | Tooltips |
| `--z-modal` | 70 | Dialogs and sheets |
| `--z-palette` | 80 | Command palette (not yet built) |
| `--z-toast` | 90 | Toasts; also the skip link |

`tokens.ts` mirrors these as numbers rather than `var()` strings, because
JavaScript comparing stacking order needs the number.

The tokens are a starting order, not the final one. A menu opened from inside a
dialog has a *lower* token than the dialog it sits in, so the token alone would
paint it behind the modal. Each layer therefore takes the greater of its own
token and one step above the current top of the open-overlay stack.

## Appendix C: Breakpoints

| Token | Value |
| --- | --- |
| `--breakpoint-sm` | 640px |
| `--breakpoint-md` | 900px |
| `--breakpoint-lg` | 1200px |
| `--breakpoint-xl` | 1600px |

Mirrored in `tokens.ts` as numbers. A workstation is a wide-viewport product, so
these mark where columns are dropped rather than where a layout reflows: below
`md`, the inspector and the sidebar become a `Sheet` rather than staying in the
row — which is why `Sheet` carries exactly the `Dialog` guarantees.

## Appendix D: Declared but not yet consumed

These tokens exist in `tokens.css` and no stylesheet currently reads them. They
are not dead — each is the correct token for a surface that is not built yet —
but do not assume a screen exists because its token does.

| Token | Intended surface |
| --- | --- |
| `--color-fill-selected` | A neutral selection, for a selection that must not compete with an accent selection |
| `--color-text-inverse` | Text on an inverted surface |
| `--color-diff-*` | The diff viewer |
| `--radius-3xl` | Mirrored in `tokens.ts`; unused in CSS |
| `--drawer-height` | A bottom drawer |
| `--space-10` | Page-level margins |
| `--z-base`, `--z-dropdown`, `--z-palette` | Content, dropdowns, the command palette |
| `--breakpoint-sm` … `--breakpoint-xl` | Consumed from `tokens.ts` rather than CSS |

Two files named in `packages/ui/package.json` — `src/index.ts` and
`src/styles.css` — do not exist yet. Until they do, import from the module that
declares the component (`'../primitives/Button.js'`) and include the stylesheets
individually.
