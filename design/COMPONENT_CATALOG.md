# Component catalog

Every component that exists in `packages/ui/src`, by layer. Generated against
the real exports, so nothing here is aspirational.

**Composition rule.** A layer may import from the layers above it in this list
and never the reverse:

```
tokens  →  primitives  →  layouts  →  components  →  patterns
                icons  →  (available to every layer above tokens)
```

`patterns` is the only layer that knows about Meridian's domain types. That is
what keeps `primitives` and `layouts` reusable and testable without a gateway.

Production screens compose these components. A one-off style in a screen is a
defect: it cannot follow the theme, cannot respond to reduced motion, and
cannot be changed in one place.

---

## Inventory


### Tokens


### Primitives

**`packages/ui/src/primitives/Button.tsx`**

- Components: Button, ButtonGroup, IconButton
- Types: 5 exported interfaces/types

**`packages/ui/src/primitives/Controls.tsx`**

- Components: Avatar, Badge, Kbd, Meter, Progress, SegmentedControl, Skeleton, Stars, StatusChip, Tab, TabList, TabPanel, Tabs
- Types: 21 exported interfaces/types

**`packages/ui/src/primitives/Form.tsx`**

- Components: Checkbox, DisclosureRow, Field, Fieldset, FormRow, Input, Radio, RadioGroup, SearchField, Select, Slider, Switch, TextArea
- Types: 14 exported interfaces/types

**`packages/ui/src/primitives/Overlay.tsx`**

- Components: ContextMenu, Dialog, Menu, MenuGroup, MenuItem, MenuSeparator, Popover, Sheet, Toast, ToastProvider, Tooltip
- Functions: useToast
- Types: 23 exported interfaces/types

**`packages/ui/src/primitives/util.ts`**

- Functions: cx, formatShortcut, isApplePlatform, matchesShortcut
- Types: 0 exported interfaces/types


### Layouts

**`packages/ui/src/layouts/Layout.tsx`**

- Components: Card, EmptyState, Inspector, Panel, PanelBody, PanelHeader, Sidebar, SidebarItem, SidebarSection, SplitPane, Stack, StatusBar, Toolbar, ToolbarGroup, ToolbarSeparator
- Types: 17 exported interfaces/types


### Components

**`packages/ui/src/components/Chat.tsx`**

- Components: ChatMessage, ChatMessageList, Composer, FallbackNotice, StreamingText, Terminal, ToolCallCard
- Types: 7 exported interfaces/types

**`packages/ui/src/components/CommandPalette.tsx`**

- Components: CommandPalette
- Functions: useCommandPalette
- Types: 4 exported interfaces/types

**`packages/ui/src/components/Data.tsx`**

- Components: KeyValue, List, ListRow, Table, Timeline, TimelineStep
- Types: 13 exported interfaces/types

**`packages/ui/src/components/Editor.tsx`**

- Components: CodeBlock, CodeEditor, DiffViewer
- Functions: languageFor
- Types: 3 exported interfaces/types


### Patterns

**`packages/ui/src/patterns/Domain.tsx`**

- Components: DataUseTable, GenerationCard, ModePicker, ModelCard, ModelPicker, PoolCard, PoolPicker, PricingLabel, ProviderCard, ProviderPicker, RoutingExplanation, TaskCard, TrustLabel
- Types: 7 exported interfaces/types


### Icons

**`packages/ui/src/icons/icons.tsx`**

- Components: ICON, IconActivity, IconAlertCircle, IconAlertTriangle, IconArrowDown, IconArrowLeft, IconArrowRight, IconArrowUp, IconBarChart, IconBeaker, IconBolt, IconBookmark, IconBox, IconCheck, IconChevronDown, IconChevronLeft, IconChevronRight, IconChevronUp, IconCircle, IconCircleDot, IconCircleHalf, IconCircleSlash, IconClock, IconClose, IconCloud, IconCode, IconColumns, IconCommand, IconCompass, IconCopy, IconCornerDownLeft, IconCpu, IconDash, IconDatabase, IconDollarSign, IconDownload, IconDrag, IconExternalLink, IconEye, IconEyeOff, IconFile, IconFilter, IconFlag, IconFolder, IconFolderOpen, IconGitBranch, IconGitCommit, IconGitPullRequest, IconGlobe, IconGrid, IconHeart, IconHome, IconImage, IconInfo, IconKey, IconLayers, IconLink, IconList, IconLock, IconMaximize, IconMenu, IconMessageSquare, IconMic, IconMinimize, IconMinus, IconMoreHorizontal, IconMoreVertical, IconOption, IconPanelBottom, IconPanelRight, IconPaperclip, IconPause, IconPencil, IconPlay, IconPlus, IconRedo, IconRefresh, IconRobot, IconRoute, IconSearch
- Types: 3 exported interfaces/types


---

## Notes on the components that carry the most weight

### `Button` / `IconButton`

Four roles and only four: `primary` (the single committing action in a view),
`secondary` (a real but non-committing action), `tertiary` (a quiet action
inline with content), `destructive` (visually distinct at rest, not only on
hover). Sizes `sm` / `md` / `lg`; the largest is still a control, not a call to
action.

`IconButton` requires a `label`. It is not optional in the type, so an unnamed
icon button does not compile.

### `SplitPane`

The resizable layout primitive. Sizes are fractions that sum to 1. Dragging is
pointer-event based (`pointerdown` + `setPointerCapture`) so it works with
mouse, touch and pen from one code path. The handle is `role="separator"` with
`aria-orientation` and `aria-valuenow`, and arrow keys resize it in steps.

### `StatusChip`

The status component. Every status pairs a colour with a distinct glyph and,
optionally, text — status is never conveyed by colour alone. When no visible
label is given it still emits an `mrd-sr-only` status word.

### `Timeline` / `TimelineStep`

The agent task timeline. Each step shows a state glyph (hollow ring, pulsing
dot, check, cross, dash), a label, an optional duration, and expands via
`details` to reveal the model, provider, latency, usage, tool calls and files
touched. The connector is accent-coloured up to the current step.

### `CommandPalette` / `useCommandPalette`

Opens on `mod+k` — including from inside a text field, which is the one
shortcut that must always work. Fuzzy subsequence matching ranks an exact
prefix above a word prefix above a scattered match, with shorter labels
breaking ties. Full combobox semantics: `role="combobox"` with
`aria-activedescendant` over a `role="listbox"`.

### `CodeEditor` / `DiffViewer`

CodeMirror 6, themed entirely through CSS custom properties so it follows
light and dark without a second theme definition. `CodeEditor` updates its
document from outside without clobbering the cursor — it compares against the
current doc first. `DiffViewer` offers split (`MergeView`) and unified
(`unifiedMergeView`) modes with Accept and Reject actions.

### `Composer`

The central interaction. Auto-growing textarea to a ceiling then scrolls;
`Enter` sends, `Shift+Enter` breaks; drag-and-drop and paste-to-attach;
`leftSlot` and `rightSlot` for the app to drop in its own pickers; the send
button becomes a stop button while running.

### `FallbackNotice`

Renders a recovered provider failure on the *informational* surface, not the
error one. A failure the system recovered from is normal operation, and
dressing it in red teaches people to distrust a working product.

### `RoutingExplanation`

The transparency surface. Summary, criteria checklist with glyph and text,
ranked runners-up with scores, and the rejected candidates with the rule that
rejected each. A router that cannot explain a rejection is one nobody can
debug.

### `PricingLabel` / `DataUseTable`

The honesty components. `PricingLabel` never renders `TRIAL` or `CREDIT` as
"Free" — both expire. `DataUseTable` renders `unknown` as "Unknown — not
verified by this instance" with a link to the provider's own policy, rather
than presenting a guess as a determination.

---

## Not yet implemented

These appear in the product specification but do not exist in
`packages/ui/src` today:

- **`Table` virtualisation.** `Table` renders every row. It is fine for the
  model list at a few hundred rows; a provider returning tens of thousands
  would need windowing.
- **Storybook or a component gallery.** Components are exercised by the app and
  by the browser sweep, not by an isolated gallery.
