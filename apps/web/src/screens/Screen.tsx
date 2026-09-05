import type { ReactNode } from 'react';

/**
 * The standard screen frame: a header that does not scroll and a body that
 * does. Every screen uses it so headings, spacing and scroll behaviour are
 * identical everywhere.
 */
export function Screen({
  title,
  subtitle,
  actions,
  children,
  padded = true,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  /** Turn off for screens that manage their own full-bleed layout. */
  padded?: boolean;
}): React.JSX.Element {
  return (
    <div className="app__screen">
      <header className="app__screen-header">
        <div>
          <h1 className="mrd-title">{title}</h1>
          {subtitle && <p className="mrd-secondary">{subtitle}</p>}
        </div>
        {actions && <div className="mrd-hstack" style={{ gap: 'var(--space-2)' }}>{actions}</div>}
      </header>
      <div className={padded ? 'app__screen-body' : 'app__screen-body app__screen-body--flush'}>{children}</div>
    </div>
  );
}
