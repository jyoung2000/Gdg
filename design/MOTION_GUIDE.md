# Motion

Motion in Meridian communicates **causality and continuity**. It shows that one
thing became another, or that something arrived. It is never decoration, and it
never carries information on its own.

A workstation is used for hours. Animation that is charming once is an
irritation on the four hundredth repetition, so everything here is short,
quiet, and gets out of the way.

---

## Tokens

| Token | Value | For |
| --- | --- | --- |
| `--duration-instant` | `80ms` | Press feedback; a state change the user caused with their finger already on the control |
| `--duration-fast` | `130ms` | Hover, focus, colour and fill changes, small reveals |
| `--duration-base` | `190ms` | Panels, popovers, dialogs, drawers, anything that moves a meaningful distance |
| `--duration-slow` | `280ms` | Reserved. Nothing in the product currently uses it; it exists for a full-screen transition if one is ever needed |

| Token | Curve | For |
| --- | --- | --- |
| `--ease-out` | `cubic-bezier(0.32, 0.72, 0, 1)` | Anything the user initiated. Quick to commit, gentle to settle |
| `--ease-in-out` | `cubic-bezier(0.65, 0, 0.35, 1)` | Anything arriving without user action, so it does not snap into place |
| `--ease-linear` | `linear` | Continuous indeterminate motion only: spinners and shimmer |

The distinction between the two main curves matters. A user-initiated move
should feel like it is answering them, so it leaves fast. A toast the system
decided to show should not appear to have been fired at them.

---

## What may be animated

**Only `transform` and `opacity`**, plus `background-color`, `border-color`,
`box-shadow` and `color` for state changes.

Animating `width`, `height`, `top`, `left`, `margin` or `padding` is forbidden.
Those properties invalidate layout on every frame, which drops frames in
exactly the situations where the interface is already busy — a streaming
response, a resizing panel, a scrolling table.

The one deliberate exception is the composer's `height`, which is set
imperatively from `scrollHeight` on each change rather than transitioned. It
snaps rather than animates, because a growing input that lags behind the text
feels broken.

---

## The catalogue

| Interaction | Property | Duration | Easing |
| --- | --- | --- | --- |
| Button press | `transform: translateY(0.5px)` | instant | out |
| Button / control hover | `background-color`, `border-color`, `box-shadow` | fast | out |
| Icon button hover | `background-color`, `color` | fast | out |
| Sidebar item hover and selection | `background-color`, `color` | fast | out |
| Segmented control indicator | `transform` on the indicator | fast | out |
| Composer focus | `border-color`, `box-shadow` | fast | out |
| Popover / menu entry | `opacity`, `transform` | base | out |
| Dialog and sheet entry | `opacity`, `transform` | base | out |
| Scrim fade | `opacity` | fast | out |
| Assistant overlay (narrow) | `transform: translateX` + `opacity` | base | out |
| Sidebar drawer (narrow) | `transform: translateX` | base | out |
| Toast entry | `opacity`, `transform: translateY(6px)` | base | out |
| Resizer hover / drag | `background-color` | fast | out |
| Streaming caret | `opacity` blink | 1.05s steps | linear |
| Button spinner | `transform: rotate` | 620ms | linear |
| Skeleton shimmer | `transform` on a gradient | continuous | linear |
| Timeline "running" pulse | `opacity` | continuous | in-out |

The 0.5px button press is deliberate. It is enough to feel like the control
moved under the finger and small enough that a row of buttons does not appear
to jitter.

---

## Reduced motion

Under `prefers-reduced-motion: reduce`, or when the in-app preference sets
`data-reduce-motion="true"` on the document element, **all four duration tokens
collapse to `1ms`**.

They collapse to 1ms rather than 0 on purpose: a `transitionend` handler still
fires, so any state machine waiting on one does not stall. A zero-duration
transition never fires the event, which turns a cosmetic preference into a
functional bug.

Animations that are meaningless at 1ms are disabled outright rather than sped
up:

- The **streaming caret** stops blinking and holds at 0.6 opacity, so it is
  still visible as a caret.
- The **skeleton shimmer** becomes a static tint.
- The **spinner** slows to a 2.4s rotation rather than becoming a blur.

---

## Loading and progress vocabulary

The right indicator is a function of how long the wait is and whether its
length is knowable.

| Wait | Indicator | Why |
| --- | --- | --- |
| Under ~100ms | Nothing | A spinner that flashes is worse than no spinner |
| 100ms – 1s, known shape | **Skeleton** | It shows the layout that is coming, so the page does not jump |
| 100ms – 1s, unknown shape | **Inline spinner** on the control that caused it | Keeps the cause and the effect together |
| Over 1s, measurable | **Determinate `Progress`** | A number is better than motion |
| Over 1s, not measurable | **Indeterminate `Progress`** plus a status label | The label carries the information; the bar only says "still working" |
| Streaming text | **`StreamingText` caret** | The arriving text is itself the progress indicator |
| Multi-step work | **`Timeline`** | Per-step state beats a single bar for a task with named phases |

A full-screen spinner appears exactly once: the initial application boot,
before the shell exists to show anything else.

---

## Prohibited

| Never | Because |
| --- | --- |
| Bouncing or spring overshoot | It draws the eye to the animation instead of the content, every time |
| Zooms above ~1.02 scale | The interface appears to lurch |
| Parallax | It costs frames and communicates nothing |
| Animation longer than `--duration-base` for a routine interaction | It becomes a wait |
| Animating layout properties | Frame drops precisely when the UI is busiest |
| Motion as the only signal | Invisible under reduced motion, and to anyone not looking at that region |
| Staggered list entry | Delightful once; a delay on every filter change |
| Looping animation in a resting state | An interface that never settles is an interface that never stops asking for attention |
