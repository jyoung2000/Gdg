#!/usr/bin/env python3
"""
Meridian's X11 input and capture helper.

A single long-lived process speaking newline-delimited JSON on stdin/stdout,
so a session's actions do not each pay process-spawn cost and the display
connection stays warm.

Deliberately small and auditable. It performs exactly the operations Meridian's
action protocol defines and nothing else: there is no shell, no eval, no file
access, and no network. Application launching is done with an argv exec of a
name the caller has already validated against a strict character class, never
through a shell.

The XTest + Pillow approach mirrors what pyautogui does under the hood, which
is the same layer Agent-S drives:
  https://github.com/simular-ai/Agent-S
"""

import json
import os
import shutil
import subprocess
import sys
import time
from io import BytesIO

try:
    from PIL import Image, ImageGrab
    from Xlib import X, display
    from Xlib.ext import xtest
except Exception as exc:  # pragma: no cover - reported to the caller as a fatal
    sys.stdout.write(json.dumps({"ok": False, "fatal": f"missing python deps: {exc}"}) + "\n")
    sys.stdout.flush()
    sys.exit(1)


# X keysym names for the keys Meridian's protocol allows. Anything not in this
# map is refused: the helper never converts an arbitrary string into a keysym.
KEYSYMS = {
    "Return": "Return", "Enter": "Return", "Tab": "Tab", "Escape": "Escape", "Esc": "Escape",
    "Space": "space", "BackSpace": "BackSpace", "Delete": "Delete",
    "Home": "Home", "End": "End", "Page_Up": "Prior", "Page_Down": "Next",
    "Up": "Up", "Down": "Down", "Left": "Left", "Right": "Right",
    "shift": "Shift_L", "ctrl": "Control_L", "control": "Control_L",
    "alt": "Alt_L", "super": "Super_L", "meta": "Super_L", "cmd": "Super_L",
}
for _i in range(1, 13):
    KEYSYMS[f"F{_i}"] = f"F{_i}"


class Agent:
    def __init__(self, display_name):
        self.display_name = display_name
        self.d = display.Display(display_name)
        self.root = self.d.screen().root

    def screen_size(self):
        geom = self.root.get_geometry()
        return geom.width, geom.height

    def _keycode(self, name):
        keysym_name = KEYSYMS.get(name)
        if keysym_name is None:
            if len(name) == 1 and (name.isalnum()):
                keysym_name = name
            else:
                raise ValueError(f"unsupported key {name!r}")
        from Xlib import XK

        keysym = XK.string_to_keysym(keysym_name)
        if keysym == 0:
            raise ValueError(f"unknown keysym for {name!r}")
        keycode = self.d.keysym_to_keycode(keysym)
        if not keycode:
            raise ValueError(f"no keycode for {name!r}")
        return keycode

    def move(self, x, y):
        xtest.fake_input(self.d, X.MotionNotify, x=int(x), y=int(y))
        self.d.sync()

    def click(self, x, y, button=1, count=1):
        self.move(x, y)
        for _ in range(count):
            xtest.fake_input(self.d, X.ButtonPress, button)
            xtest.fake_input(self.d, X.ButtonRelease, button)
            self.d.sync()
            if count > 1:
                time.sleep(0.05)

    def drag(self, x1, y1, x2, y2):
        self.move(x1, y1)
        xtest.fake_input(self.d, X.ButtonPress, 1)
        self.d.sync()
        # A few intermediate points: applications that track motion ignore a
        # press-then-teleport-then-release as a click, not a drag.
        steps = 12
        for i in range(1, steps + 1):
            self.move(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps)
            time.sleep(0.01)
        xtest.fake_input(self.d, X.ButtonRelease, 1)
        self.d.sync()

    def key(self, name):
        keycode = self._keycode(name)
        xtest.fake_input(self.d, X.KeyPress, keycode)
        xtest.fake_input(self.d, X.KeyRelease, keycode)
        self.d.sync()

    def hotkey(self, names):
        codes = [self._keycode(n) for n in names]
        for c in codes:
            xtest.fake_input(self.d, X.KeyPress, c)
        for c in reversed(codes):
            xtest.fake_input(self.d, X.KeyRelease, c)
        self.d.sync()

    def type_text(self, text):
        from Xlib import XK

        for ch in text:
            if ch == "\n":
                self.key("Return")
                continue
            if ch == "\t":
                self.key("Tab")
                continue
            keysym = XK.string_to_keysym(ch)
            if keysym == 0:
                # Latin-1 and friends: X names printable characters this way.
                keysym = ord(ch)
            keycode = self.d.keysym_to_keycode(keysym)
            if not keycode:
                continue
            # Work out whether this character sits on the shifted level of its
            # key, so capitals and symbols type as themselves.
            shifted = False
            try:
                mapping = self.d.keycode_to_keysym(keycode, 1)
                if mapping == keysym and self.d.keycode_to_keysym(keycode, 0) != keysym:
                    shifted = True
            except Exception:
                shifted = False
            if shifted:
                xtest.fake_input(self.d, X.KeyPress, self._keycode("shift"))
            xtest.fake_input(self.d, X.KeyPress, keycode)
            xtest.fake_input(self.d, X.KeyRelease, keycode)
            if shifted:
                xtest.fake_input(self.d, X.KeyRelease, self._keycode("shift"))
            self.d.sync()
            time.sleep(0.004)

    def scroll(self, direction, amount, at=None):
        if at:
            self.move(at[0], at[1])
        button = {"up": 4, "down": 5, "left": 6, "right": 7}[direction]
        for _ in range(max(1, int(amount))):
            xtest.fake_input(self.d, X.ButtonPress, button)
            xtest.fake_input(self.d, X.ButtonRelease, button)
            self.d.sync()
            time.sleep(0.02)

    def screenshot(self, max_width=0):
        img = ImageGrab.grab(xdisplay=self.display_name)
        if max_width and img.width > max_width:
            ratio = max_width / img.width
            img = img.resize((max_width, int(img.height * ratio)), Image.LANCZOS)
        buf = BytesIO()
        # PNG at a moderate compression: screenshots stream to a browser on
        # every step, so size matters more than the last few percent of quality.
        img.save(buf, format="PNG", optimize=False, compress_level=6)
        import base64

        return base64.b64encode(buf.getvalue()).decode("ascii"), img.width, img.height

    def open_application(self, name):
        # argv exec, never a shell. The name has already been validated by the
        # caller against a strict character class; this re-checks rather than
        # trusting that, because this process is the last line before exec.
        if not name or not all(c.isalnum() or c in " ._+-" for c in name):
            raise ValueError("invalid application name")
        binary = shutil.which(name)
        if binary is None:
            raise ValueError(f"{name} is not on PATH")
        env = dict(os.environ)
        env["DISPLAY"] = self.display_name
        subprocess.Popen(
            [binary],
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        return binary


def main():
    display_name = os.environ.get("MERIDIAN_DISPLAY") or os.environ.get("DISPLAY") or ":0"
    try:
        agent = Agent(display_name)
        w, h = agent.screen_size()
    except Exception as exc:
        sys.stdout.write(json.dumps({"ok": False, "fatal": f"cannot open display {display_name}: {exc}"}) + "\n")
        sys.stdout.flush()
        return 1

    sys.stdout.write(json.dumps({"ok": True, "ready": True, "width": w, "height": h, "display": display_name}) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            sys.stdout.write(json.dumps({"ok": False, "error": "malformed request"}) + "\n")
            sys.stdout.flush()
            continue

        rid = req.get("id")
        op = req.get("op")
        try:
            if op == "screenshot":
                data, iw, ih = agent.screenshot(int(req.get("maxWidth") or 0))
                out = {"ok": True, "id": rid, "data": data, "width": iw, "height": ih}
            elif op == "move":
                agent.move(req["x"], req["y"])
                out = {"ok": True, "id": rid}
            elif op == "click":
                agent.click(req["x"], req["y"], int(req.get("button", 1)), int(req.get("count", 1)))
                out = {"ok": True, "id": rid}
            elif op == "drag":
                agent.drag(req["x1"], req["y1"], req["x2"], req["y2"])
                out = {"ok": True, "id": rid}
            elif op == "type":
                agent.type_text(req["text"])
                out = {"ok": True, "id": rid}
            elif op == "key":
                agent.key(req["key"])
                out = {"ok": True, "id": rid}
            elif op == "hotkey":
                agent.hotkey(req["keys"])
                out = {"ok": True, "id": rid}
            elif op == "scroll":
                agent.scroll(req["direction"], req.get("amount", 3), req.get("at"))
                out = {"ok": True, "id": rid}
            elif op == "open":
                path = agent.open_application(req["name"])
                out = {"ok": True, "id": rid, "path": path}
            elif op == "size":
                w, h = agent.screen_size()
                out = {"ok": True, "id": rid, "width": w, "height": h}
            elif op == "ping":
                out = {"ok": True, "id": rid}
            else:
                out = {"ok": False, "id": rid, "error": f"unknown op {op!r}"}
        except Exception as exc:
            out = {"ok": False, "id": rid, "error": str(exc)}

        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
