# Interaction

How Meridian behaves under the hand. The governing idea is that this is a
**desktop application that happens to run in a browser**: keyboard-first,
direct manipulation, persistent layout, no navigation that loses your place.

---

## 1. Keyboard

Every action reachable with a pointer is reachable from the keyboard.

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| Command palette | `⌘K` | `Ctrl+K` |
| Toggle sidebar | `⌘B` | `Ctrl+B` |
| Toggle terminal drawer | `⌘J` | `Ctrl+J` |
| Toggle assistant panel | `⌘I` | `Ctrl+I` |
| Save file | `⌘S` | `Ctrl+S` |
| Send / run | `↵` | `Enter` |
| Newline in the composer | `⇧↵` | `Shift+Enter` |
| Close overlay | `Esc` | `Esc` |
| Move within a list or menu | `↑` `↓` | `↑` `↓` |
| First / last item | `Home` `End` | `Home` `End` |
| Move between tabs | `←` `→` | `←` `→` |
| Resize a split | `←` `→` on the divider | same |

Shortcut display is platform-aware: `formatShortcut` in
`packages/ui/src/primitives/util.ts` renders `⌘K` on Apple platforms and
`Ctrl+K` elsewhere, and `matchesShortcut` treats `mod` as `⌘` or `Ctrl`
accordingly. There is one shortcut definition, rendered two ways.

**Focus model.** `:focus-visible` only, so a click does not paint a ring but a
`Tab` does. Composite widgets (lists, menus, tabs, toolbars) use a roving
tabindex: the group is one tab stop and arrows move within it. Overlays trap
focus while open and restore it to the opener on close.

`⌘K` is the one shortcut that fires even when focus is inside a text field.
Everything else defers to the field, because a shortcut that eats a keystroke
mid-sentence is worse than a shortcut that is one `Esc` away.

---

## 2. The command palette

The primary way to reach anything.

- Opens on `mod+k` from anywhere, closes on `Esc`.
- Commands are grouped — Actions, Navigate, Workspaces, Models, Appearance —
  with the group name as a header.
- Matching is fuzzy subsequence over label plus keywords. Ranking: an exact
  prefix beats a word prefix, which beats a scattered subsequence; shorter
  labels break ties. Matched characters are marked in the rendered label.
- `↑` `↓` move across group boundaries and wrap; the active item is scrolled
  into view with `block: 'nearest'` so the list does not jump.
- A command's own shortcut is shown on the right, which is how shortcuts are
  discovered.

---

## 3. Direct manipulation

| Gesture | Result |
| --- | --- |
| Drag a divider | Resize the adjacent panels; the size persists |
| Drag an editor tab | Reorder open files |
| Drag a file onto the composer | Attach it |
| Paste an image into the composer | Attach it |
| Click a timeline step | Expand its detail in place |
| Click a sidebar section header | Collapse the section |

Dragging uses **pointer events** with `setPointerCapture`, not mouse events.
One code path then serves mouse, touch and pen, and the capture guarantees the
drag still ends correctly if the pointer leaves the window.

Resizer handles extend their hit area 4px either side of the 1px visible line,
so the target is reachable without precision aiming.

---

## 4. Menus and context menus

Menus follow desktop conventions: icon, label, shortcut, and a chevron for a
submenu. Related commands are grouped with separators. Destructive items sit at
the end of their group and are visually distinct at rest.

Context menus open on `contextmenu` at the pointer and on the keyboard's
context-menu key, and are ordinary `Menu`s — so the same keyboard behaviour
applies.

---

## 5. Selection

- **Single selection** in lists and the file tree, shown with a filled row and
  `aria-selected`.
- **Multiple selection** in the model list, for comparison — a checkbox per
  row rather than modifier-clicking, because the action it feeds (compare) is
  explicit and the set needs to be visible.
- Selection survives a filter change where the selected item still matches.

---

## 6. Undo, and never destroying work

This is the product's central safety property, so it is stated as a rule:

> **An agent's change is written to disk so tests can run against it, and its
> previous content is recorded so it can be restored exactly.**

- Every write records the pre-task content on the **first** write to that path,
  so several edits to one file still revert to the original.
- **Reject** restores the previous bytes; for a file the agent created, it
  deletes the file.
- **Accept** marks the change kept.
- Accept-all and reject-all operate on the whole change set.
- The file tree marks changed files with a coloured dot carrying a `title`, so
  what an agent touched is visible without opening the diff.

Editor-level undo is CodeMirror's own history, `⌘Z` / `⌘⇧Z`.

---

## 7. Confirmation

Confirmation is reserved for actions that are **irreversible or spend money**:

- Running a task with a non-zero cost estimate. The CLI asks; the app shows the
  estimate before the run and requires the explicit action.
- Deleting a pool or revoking an API key.
- Discarding a change set.

Everything else proceeds. A confirmation dialog on a reversible action trains
people to dismiss dialogs without reading them, which is how the irreversible
one gets dismissed too.

Removing a workspace deliberately does **not** delete its directory, and says
so — a destructive filesystem action is not something an interface should do
on one click.

---

## 8. Feedback

| Kind | Where | For |
| --- | --- | --- |
| Inline | Beside the control | Validation, a failed field |
| Toast | Bottom right | The result of an action the user started elsewhere |
| Status bar | Bottom strip | Ambient state: connection, model count, paid routing |
| Timeline | Assistant panel | Multi-step progress |
| Fallback notice | Assistant panel and toast | A recovered provider failure |

Error toasts persist until dismissed; everything else clears itself after six
seconds. An error the user did not see is an error that gets reported as a bug.

---

## 9. Error recovery and tone

Errors state what happened and what to do, in that order, without apology or
alarm.

The provider-fallback notice is the worked example:

> **Groq is rate limited right now. Switching to qwen-2.5-coder.**
> ✓ Task continuing · *Detail*

Expanding gives provider, reason, fallback model and expected impact. It is
rendered on the informational surface, not the error one, because a failure
the system recovered from without the user's involvement is **normal
operation**. Colouring it red teaches people to distrust a working product.

Where Meridian genuinely does not know something — a provider's data-use
policy, a model's quality before it has been measured — it says "unknown" or
"not measured". A confident wrong answer is worse than an honest gap.

---

## 10. Persistence

Remembered on the device, in `localStorage`:

- Theme and reduced-motion preference (applied before first paint by a small
  inline script, so the app never flashes the wrong theme).
- Sidebar collapsed state, assistant panel visibility, drawer visibility and
  its active tab, and split-pane sizes.

Remembered on the server, per user:

- Routing mode, privacy mode, preferred models and providers, preferred pool,
  paid-routing permission and per-task cost ceiling.

Both are read at boot. The server's copy wins where they disagree, because it
follows the user between devices.
