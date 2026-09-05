/**
 * Typed mirror of the CSS custom properties in tokens.css.
 *
 * CSS is the source of truth — these constants exist so TypeScript can
 * reference a token by name (in an inline style, a canvas render, or a chart)
 * without hard-coding the string and drifting from the stylesheet.
 */

export const space = {
  1: 'var(--space-1)',
  2: 'var(--space-2)',
  3: 'var(--space-3)',
  4: 'var(--space-4)',
  5: 'var(--space-5)',
  6: 'var(--space-6)',
  7: 'var(--space-7)',
  8: 'var(--space-8)',
  9: 'var(--space-9)',
  10: 'var(--space-10)',
  11: 'var(--space-11)',
} as const;

export const radius = {
  sm: 'var(--radius-sm)',
  md: 'var(--radius-md)',
  lg: 'var(--radius-lg)',
  xl: 'var(--radius-xl)',
  '2xl': 'var(--radius-2xl)',
  '3xl': 'var(--radius-3xl)',
  pill: 'var(--radius-pill)',
} as const;

export const color = {
  bg: 'var(--color-bg)',
  surface: 'var(--color-surface)',
  surfaceRaised: 'var(--color-surface-raised)',
  surfaceSunken: 'var(--color-surface-sunken)',
  separator: 'var(--color-separator)',
  border: 'var(--color-border)',
  borderStrong: 'var(--color-border-strong)',
  textPrimary: 'var(--color-text-primary)',
  textSecondary: 'var(--color-text-secondary)',
  textTertiary: 'var(--color-text-tertiary)',
  accent: 'var(--color-accent)',
  accentSubtle: 'var(--color-accent-subtle)',
  success: 'var(--color-success)',
  warning: 'var(--color-warning)',
  error: 'var(--color-error)',
  info: 'var(--color-info)',
  fillQuiet: 'var(--color-fill-quiet)',
  fillHover: 'var(--color-fill-hover)',
  fillActive: 'var(--color-fill-active)',
} as const;

export const shadow = {
  0: 'var(--shadow-0)',
  1: 'var(--shadow-1)',
  2: 'var(--shadow-2)',
  3: 'var(--shadow-3)',
  4: 'var(--shadow-4)',
  focus: 'var(--shadow-focus)',
} as const;

export const duration = {
  instant: 'var(--duration-instant)',
  fast: 'var(--duration-fast)',
  base: 'var(--duration-base)',
  slow: 'var(--duration-slow)',
} as const;

export const easing = {
  out: 'var(--ease-out)',
  inOut: 'var(--ease-in-out)',
  linear: 'var(--ease-linear)',
} as const;

export const zIndex = {
  base: 0,
  sticky: 10,
  toolbar: 20,
  dropdown: 40,
  popover: 50,
  tooltip: 60,
  modal: 70,
  palette: 80,
  toast: 90,
} as const;

export const breakpoint = {
  sm: 640,
  md: 900,
  lg: 1200,
  xl: 1600,
} as const;

/** Elevation level → shadow token. Level is a design concept; shadow is its rendering. */
export const elevation = [shadow[0], shadow[1], shadow[2], shadow[3], shadow[4]] as const;
export type ElevationLevel = 0 | 1 | 2 | 3 | 4;
