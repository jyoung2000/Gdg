/** Join class names, dropping anything falsy. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** Detect the platform so shortcut hints read ⌘K on Mac and Ctrl+K elsewhere. */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const p = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(p);
}

/** Render a shortcut for display, e.g. "mod+k" → "⌘K" or "Ctrl+K". */
export function formatShortcut(combo: string, apple = isApplePlatform()): string {
  const parts = combo.split('+').map((p) => p.trim().toLowerCase());
  const out: string[] = [];
  for (const p of parts) {
    switch (p) {
      case 'mod':
        out.push(apple ? '⌘' : 'Ctrl');
        break;
      case 'shift':
        out.push(apple ? '⇧' : 'Shift');
        break;
      case 'alt':
      case 'option':
        out.push(apple ? '⌥' : 'Alt');
        break;
      case 'ctrl':
        out.push(apple ? '⌃' : 'Ctrl');
        break;
      case 'enter':
      case 'return':
        out.push(apple ? '↵' : 'Enter');
        break;
      case 'escape':
      case 'esc':
        out.push('Esc');
        break;
      case 'backspace':
        out.push(apple ? '⌫' : 'Backspace');
        break;
      case 'up':
        out.push('↑');
        break;
      case 'down':
        out.push('↓');
        break;
      default:
        out.push(p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1));
    }
  }
  // Apple convention concatenates modifiers; everything else joins with +.
  return apple ? out.join('') : out.join('+');
}

/** True when a keyboard event matches a "mod+k"-style combo. */
export function matchesShortcut(e: KeyboardEvent, combo: string): boolean {
  const parts = combo.split('+').map((p) => p.trim().toLowerCase());
  const key = parts[parts.length - 1];
  const need = new Set(parts.slice(0, -1));
  const mod = e.metaKey || e.ctrlKey;
  if (need.has('mod') && !mod) return false;
  if (!need.has('mod') && (e.metaKey || e.ctrlKey) && !need.has('ctrl')) return false;
  if (need.has('shift') !== e.shiftKey) return false;
  if (need.has('alt') !== e.altKey) return false;
  const pressed = e.key.toLowerCase();
  const normalised = pressed === ' ' ? 'space' : pressed;
  return normalised === key || (key === 'enter' && normalised === 'return');
}
