# Meridian GUI — local mockup

`meridian-gui-mockup.html` is a single, self-contained, offline copy of the
Meridian web client, for looking at the interface and editing it locally with
nothing installed. Open it by double-clicking, or:

```
xdg-open docs/mockup/meridian-gui-mockup.html   # or just drag it into a browser
```

## What it is — and what it is not

It is **1:1 by construction, not by hand**. A real browser loaded the real
built client against a running gateway, and each of the 21 screens was captured
as its **actual rendered DOM**. The styling is the app's **own compiled
stylesheet, inlined verbatim**. So what you see is what the app renders, down to
the pixel — including the reasoning-effort control in the chat composer, the
Projects screen, and the Computer screen.

It is **static and inert**. Nothing talks to a server: buttons, inputs, tabs
inside a screen and links do nothing. The only live control is the app's own
left sidebar, which switches between the 21 captured screens. The sidebar in
this file is deliberately left with its "More" disclosure **open**: every
captured screen carries its own copy of the sidebar, and a collapsed one would
produce a mockup you could enter and not leave. This is a design
surface, not a running app — for the running app, build and serve the client
(`node scripts/build.mjs`, then run the gateway).

Because the markup is captured from React, you will see `data-*` attributes and
the odd inline style. That is harmless; treat them as noise you can ignore or
delete.

## Editing it

- **Change how things look:** edit the first `<style>` block — that is
  Meridian's real design-system CSS (tokens, components, layout). Changing a
  token there (say `--mrd-accent`) restyles every screen at once, exactly as it
  would in the app.
- **Change a screen's content or structure:** edit the markup inside the
  matching `<section data-screen="…">`.
- The second `<style>` block and the single `<script>` are the mockup's own
  chrome (the top bar and the screen switcher). They are not part of Meridian.

## Regenerating it

When the real GUI changes, regenerate rather than hand-patch:

```
pnpm mockup
```

That is the whole command. It builds, starts a throwaway gateway on a free port
in a temporary directory, captures the mockup, shoots the previews, writes
`previews.json`, and stops the gateway. Nothing is left running and nothing is
written outside this folder. `pnpm mockup --no-build` reuses the `dist/` that is
already there.

It used to be four steps with a gateway to start and a port to remember, which
is why the previews sat weeks behind the interface they claimed to show. The
release gate (`node scripts/check-offline-ui.mjs`, and CI) now fails when the
mockup or the previews were built from older UI source than the tree contains,
so a stale artefact is a red build rather than a surprise.

Under the covers: `scripts/capture-gui-mockup.mts` navigates every screen
through the real sidebar and inlines the compiled stylesheet it finds in
`dist/web/assets`; `scripts/shoot-previews.mjs` takes the screenshots.

## Previews

`preview-chat.png`, `preview-projects.png`, `preview-director.png`,
`preview-discover.png`, `preview-computer.png`, `preview-models.png` and
`preview-settings.png` are screenshots kept so the look is reviewable without
opening a browser.

They are shot from the **running application**, not from the mockup. The
difference matters: the mockup holds the "More" disclosure open so it stays
navigable, so a preview taken from it would show all twenty-one destinations at
once — the interface the simplification removed. Shot from the app, each picture
shows the sidebar a user would actually be looking at on that screen.

`previews.json` records the UI-source fingerprint they were shot from, because a
PNG cannot carry a comment and the gate needs some way to tell that the pictures
are current.
