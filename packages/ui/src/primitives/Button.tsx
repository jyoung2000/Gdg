import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cx } from './util.js';

export type ButtonVariant = 'primary' | 'secondary' | 'tertiary' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading glyph. Sized by the button, so pass an icon component, not a box. */
  icon?: ReactNode;
  trailingIcon?: ReactNode;
  /** Shows a spinner and blocks interaction without changing the button's width. */
  loading?: boolean;
  fullWidth?: boolean;
  type?: 'button' | 'submit' | 'reset';
}

/**
 * The four button roles, and only four.
 *
 * Primary is the single committing action in a view; secondary is a real but
 * non-committing action; tertiary is a quiet action that lives inline with
 * content; destructive is visually distinct so it can never be mistaken for
 * primary. There is deliberately no "large marketing button" — the largest size
 * here is still a control, not a call to action.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, trailingIcon, loading = false, fullWidth = false, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx('mrd-button', `mrd-button--${variant}`, `mrd-button--${size}`, fullWidth && 'mrd-button--full', 'mrd-focus-ring', className)}
      disabled={disabled || loading}
      data-loading={loading || undefined}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="mrd-button__spinner" aria-hidden="true" /> : icon ? <span className="mrd-button__icon">{icon}</span> : null}
      {children ? <span className="mrd-button__label">{children}</span> : null}
      {trailingIcon && !loading ? <span className="mrd-button__icon">{trailingIcon}</span> : null}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonProps, 'icon' | 'trailingIcon' | 'children'> {
  /** Required: an icon-only control is unusable to a screen reader without it. */
  label: string;
  icon: ReactNode;
  /** Renders the pressed state for toggles. */
  pressed?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, pressed, variant = 'tertiary', size = 'md', className, disabled, loading, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx('mrd-icon-button', `mrd-icon-button--${variant}`, `mrd-icon-button--${size}`, 'mrd-focus-ring', className)}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      data-pressed={pressed || undefined}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <span className="mrd-button__spinner" aria-hidden="true" /> : icon}
    </button>
  );
});

export interface ButtonGroupProps {
  children: ReactNode;
  className?: string;
  /** Adds a gap instead of joining the buttons into one control. */
  spaced?: boolean;
}

export function ButtonGroup({ children, className, spaced }: ButtonGroupProps): React.JSX.Element {
  return <div className={cx('mrd-button-group', spaced && 'mrd-button-group--spaced', className)}>{children}</div>;
}
