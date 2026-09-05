import { useEffect, useState } from 'react';

/**
 * Subscribe to a media query.
 *
 * The responsive layout is a re-composition, not a resize: below the breakpoint
 * the assistant becomes an overlay and the sidebar becomes a drawer, which are
 * different component trees rather than different widths. That decision has to
 * be made in JavaScript, so the query lives here rather than only in CSS.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => (typeof window === 'undefined' ? false : window.matchMedia(query).matches));

  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = (): void => setMatches(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/** The three layout modes the product is designed for. */
export const BREAKPOINT = {
  /** Below this the shell is a single pane with drawers. */
  mobile: '(max-width: 640px)',
  /** Below this the assistant is an overlay rather than a third column. */
  narrow: '(max-width: 1200px)',
} as const;
