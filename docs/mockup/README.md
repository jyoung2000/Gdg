# Meridian GUI — local mockup

`meridian-gui-mockup.html` is a single, self-contained, offline copy of the
Meridian web client, for looking at the interface and editing it locally with
nothing installed. Open it by double-clicking, or:

```
xdg-open docs/mockup/meridian-gui-mockup.html   # or just drag it into a browser
```

## What it is — and what it is not

It is **1:1 by construction, not by hand**. A real browser loaded the real
built client against a running gateway, and each of the 18 screens was captured
as its **actual rendered DOM**. The styling is the app's **own compiled
stylesheet, inlined verbatim**. So what you see is what the app renders, down to
the pixel — including the reasoning-effort control in the chat composer and the
Computer screen.

It is **static and inert**. Nothing talks to a server: buttons, inputs, tabs
inside a screen and links do nothing. The only live control is the dark bar at
the top, which switches between the 18 captured screens. This is a design
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

When the real GUI changes, regenerate rather than hand-patch. With a gateway
serving the built client (and, ideally, a local model server discovered so the
data-driven screens have content):

```
node scripts/build.mjs
# start a gateway with MERIDIAN_WEB_ROOT=dist/web pointed at some models …
npx tsx scripts/capture-gui-mockup.mts <gatewayBaseUrl> <path-to-compiled-css> docs/mockup/meridian-gui-mockup.html
```

The capture script is `scripts/capture-gui-mockup.mts`; it navigates every
screen through the real sidebar and writes the file. The compiled CSS path is
whatever `dist/web/index.html` currently references under `assets/`.

## Previews

`preview-chat.png`, `preview-models.png`, `preview-computer.png` and
`preview-settings.png` are screenshots of the mockup as rendered from `file://`,
kept so the look is reviewable without opening a browser.
