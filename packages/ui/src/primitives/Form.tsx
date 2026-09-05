import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ChangeEvent,
  type CSSProperties,
  type ForwardedRef,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cx } from './util.js';

export type ControlSize = 'sm' | 'md' | 'lg';

/**
 * How a control learns its identity from the layout around it.
 *
 * Field and FormRow already own the label, the description and the error, so a
 * control placed inside one should not repeat that wiring — it reads the ids
 * from here instead. `labelId` exists separately from the label's `for`
 * because a Switch is a <button>, and a <label for> cannot name a button.
 */
interface FormControlContextValue {
  controlId: string;
  labelId?: string;
  describedBy?: string;
  invalid?: boolean;
  required?: boolean;
}

const FormControlContext = createContext<FormControlContextValue | null>(null);

interface ControlWiring {
  id?: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  ariaDescribedBy?: string;
  invalid?: boolean;
  description?: ReactNode;
  error?: ReactNode;
  /** True when the component renders its own <label> around the control. */
  selfLabelled?: boolean;
}

function useControlWiring({ id, ariaLabel, ariaLabelledBy, ariaDescribedBy, invalid, description, error, selfLabelled }: ControlWiring) {
  const uid = useId();
  const field = useContext(FormControlContext);
  const descriptionId = description ? `${uid}-description` : undefined;
  const errorId = error ? `${uid}-error` : undefined;
  // A control can be described from three places at once — the surrounding
  // Field, its own help text, and the consumer — and all three must survive.
  const describedBy = [ariaDescribedBy, field?.describedBy, descriptionId, errorId].filter(Boolean).join(' ') || undefined;
  // A control that already carries a name must not have the surrounding row's
  // label bolted on top of it — aria-labelledby would silently win.
  const named = Boolean(ariaLabel) || Boolean(selfLabelled);
  return {
    controlId: id ?? field?.controlId ?? uid,
    labelledBy: ariaLabelledBy ?? (named ? undefined : field?.labelId),
    describedBy,
    descriptionId,
    errorId,
    invalid: invalid ?? field?.invalid,
    required: field?.required,
  };
}

/** Keeps a forwarded ref working alongside a ref the component needs itself. */
function useForkRef<T>(external: ForwardedRef<T>, internal: { current: T | null }) {
  return useCallback(
    (node: T | null) => {
      internal.current = node;
      if (typeof external === 'function') external(node);
      else if (external) (external as { current: T | null }).current = node;
    },
    [external, internal],
  );
}

function SearchGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.4 10.4 14 14" />
    </svg>
  );
}

function ClearGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M4.6 4.6 11.4 11.4M11.4 4.6 4.6 11.4" />
    </svg>
  );
}

function ChevronGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}

function AlertGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.6v4" />
      <path d="M8 11.2h.01" />
    </svg>
  );
}

interface NotesProps {
  description?: ReactNode;
  descriptionId?: string;
  error?: ReactNode;
  errorId?: string;
}

/**
 * Help and error text. The error carries a glyph as well as the error colour,
 * so the failure is legible to someone who cannot separate red from grey, and
 * role="alert" announces a validation failure that appears while the user is
 * still inside the field.
 */
function FieldNotes({ description, descriptionId, error, errorId }: NotesProps): React.JSX.Element | null {
  if (!description && !error) return null;
  return (
    <>
      {description ? (
        <p className="mrd-field-note" id={descriptionId}>
          {description}
        </p>
      ) : null}
      {error ? (
        <p className="mrd-field-note mrd-field-note--error" id={errorId} role="alert">
          <span className="mrd-field-note__glyph">
            <AlertGlyph />
          </span>
          <span>{error}</span>
        </p>
      ) : null}
    </>
  );
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: ControlSize;
  /** Decorative leading glyph, sized by the control and hidden from assistive tech. */
  icon?: ReactNode;
  /** Trailing content: a unit, a shortcut hint, a small button. */
  adornment?: ReactNode;
  invalid?: boolean;
  description?: ReactNode;
  error?: ReactNode;
  fullWidth?: boolean;
}

/**
 * A text field, in the same three control heights as Button so a field and a
 * button sit on one line without either looking mispositioned.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { size = 'md', icon, adornment, invalid, description, error, fullWidth = false, className, disabled, id, type = 'text', ...rest },
  ref,
) {
  const wiring = useControlWiring({
    id,
    ariaLabel: rest['aria-label'],
    ariaLabelledBy: rest['aria-labelledby'],
    ariaDescribedBy: rest['aria-describedby'],
    invalid,
    description,
    error,
  });
  return (
    <div className={cx('mrd-field-control', fullWidth && 'mrd-field-control--full', className)}>
      <div className={cx('mrd-input', `mrd-input--${size}`)} data-invalid={wiring.invalid || undefined} data-disabled={disabled || undefined}>
        {icon ? (
          <span className="mrd-input__icon" aria-hidden="true">
            {icon}
          </span>
        ) : null}
        <input
          ref={ref}
          id={wiring.controlId}
          type={type}
          className="mrd-input__control"
          disabled={disabled}
          aria-invalid={wiring.invalid || undefined}
          aria-required={wiring.required || undefined}
          aria-labelledby={wiring.labelledBy}
          {...rest}
          aria-describedby={wiring.describedBy}
        />
        {adornment ? <span className="mrd-input__adornment">{adornment}</span> : null}
      </div>
      <FieldNotes description={description} descriptionId={wiring.descriptionId} error={error} errorId={wiring.errorId} />
    </div>
  );
});

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  description?: ReactNode;
  error?: ReactNode;
  fullWidth?: boolean;
  /** Vertical is the default; a field that cannot grow traps long prompts. */
  resize?: 'none' | 'vertical';
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { invalid, description, error, fullWidth = false, resize = 'vertical', rows = 4, className, disabled, id, ...rest },
  ref,
) {
  const wiring = useControlWiring({
    id,
    ariaLabel: rest['aria-label'],
    ariaLabelledBy: rest['aria-labelledby'],
    ariaDescribedBy: rest['aria-describedby'],
    invalid,
    description,
    error,
  });
  return (
    <div className={cx('mrd-field-control', fullWidth && 'mrd-field-control--full', className)}>
      <textarea
        ref={ref}
        id={wiring.controlId}
        rows={rows}
        className={cx('mrd-textarea', resize === 'none' && 'mrd-textarea--fixed')}
        disabled={disabled}
        data-invalid={wiring.invalid || undefined}
        aria-invalid={wiring.invalid || undefined}
        aria-required={wiring.required || undefined}
        aria-labelledby={wiring.labelledBy}
        {...rest}
        aria-describedby={wiring.describedBy}
      />
      <FieldNotes description={description} descriptionId={wiring.descriptionId} error={error} errorId={wiring.errorId} />
    </div>
  );
});

export interface SearchFieldProps extends Omit<InputProps, 'icon' | 'adornment' | 'type' | 'defaultValue' | 'value'> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** Fires after the field is emptied, by the clear button or by Escape. */
  onClear?: () => void;
  clearLabel?: string;
}

/**
 * Search, with the two behaviours people expect from a search field: a clear
 * affordance that only exists while there is something to clear, and Escape to
 * empty it.
 */
export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { value, defaultValue, onValueChange, onClear, clearLabel = 'Clear search', onChange, onKeyDown, disabled, placeholder = 'Search', ...rest },
  ref,
) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const setRefs = useForkRef(ref, inputRef);
  // Mirrored rather than left to the DOM: the clear button's existence depends
  // on the current value, so React has to know it either way.
  const [internal, setInternal] = useState(() => defaultValue ?? '');
  const current = value ?? internal;

  const commit = useCallback(
    (next: string) => {
      if (value === undefined) setInternal(next);
      onValueChange?.(next);
    },
    [onValueChange, value],
  );

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    commit(event.target.value);
    onChange?.(event);
  };

  const clear = () => {
    commit('');
    onClear?.();
    inputRef.current?.focus();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event);
    if (event.key !== 'Escape' || event.defaultPrevented || current === '') return;
    // Escape belongs to the field while it has content; without stopping it the
    // palette or dialog holding the field would close on the first press.
    event.preventDefault();
    event.stopPropagation();
    clear();
  };

  return (
    <Input
      autoComplete="off"
      spellCheck={false}
      {...rest}
      ref={setRefs}
      type="search"
      value={current}
      placeholder={placeholder}
      disabled={disabled}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      icon={<SearchGlyph />}
      adornment={
        current ? (
          <button type="button" className="mrd-search-clear mrd-focus-ring" aria-label={clearLabel} onClick={clear} disabled={disabled}>
            <ClearGlyph />
          </button>
        ) : null
      }
    />
  );
});

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  size?: ControlSize;
  invalid?: boolean;
  description?: ReactNode;
  error?: ReactNode;
  fullWidth?: boolean;
  /** Rendered as a disabled first option, so an empty value still reads. */
  placeholder?: string;
}

/**
 * A native <select> wearing Meridian's clothes. Native is the right call: it
 * inherits type-ahead, the platform keyboard model and the system picker on
 * touch, none of which a listbox reimplementation gets for free.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { size = 'md', invalid, description, error, fullWidth = false, placeholder, className, disabled, id, children, ...rest },
  ref,
) {
  const wiring = useControlWiring({
    id,
    ariaLabel: rest['aria-label'],
    ariaLabelledBy: rest['aria-labelledby'],
    ariaDescribedBy: rest['aria-describedby'],
    invalid,
    description,
    error,
  });
  return (
    <div className={cx('mrd-field-control', fullWidth && 'mrd-field-control--full', className)}>
      <div className={cx('mrd-select', `mrd-select--${size}`)} data-invalid={wiring.invalid || undefined} data-disabled={disabled || undefined}>
        <select
          ref={ref}
          id={wiring.controlId}
          className="mrd-select__control"
          disabled={disabled}
          aria-invalid={wiring.invalid || undefined}
          aria-required={wiring.required || undefined}
          aria-labelledby={wiring.labelledBy}
          {...rest}
          aria-describedby={wiring.describedBy}
        >
          {placeholder ? (
            <option value="" disabled>
              {placeholder}
            </option>
          ) : null}
          {children}
        </select>
      </div>
      <FieldNotes description={description} descriptionId={wiring.descriptionId} error={error} errorId={wiring.errorId} />
    </div>
  );
});

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  /** Visible text. Without it, pass an aria-label or place the box in a FormRow. */
  label?: ReactNode;
  description?: ReactNode;
  /** Mixed state, for a parent whose children are partly selected. */
  indeterminate?: boolean;
}

/**
 * A real checkbox behind a drawn one. The native input keeps form submission,
 * the space key, `indeterminate` and the platform's own accessibility mapping;
 * only its pixels are replaced.
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, description, indeterminate = false, className, disabled, id, ...rest },
  ref,
) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const setRefs = useForkRef(ref, inputRef);
  const wiring = useControlWiring({
    id,
    ariaLabel: rest['aria-label'],
    ariaLabelledBy: rest['aria-labelledby'],
    ariaDescribedBy: rest['aria-describedby'],
    description,
    selfLabelled: label != null,
  });

  // `indeterminate` exists only as a DOM property, and clicking a mixed box
  // clears it in the browser without telling React — so it is re-asserted on
  // every render rather than only when the prop itself changes.
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate;
  });

  return (
    <label className={cx('mrd-choice', 'mrd-choice--checkbox', className)} data-disabled={disabled || undefined}>
      <input
        ref={setRefs}
        id={wiring.controlId}
        type="checkbox"
        className="mrd-choice__input mrd-sr-only"
        disabled={disabled}
        aria-labelledby={wiring.labelledBy}
        {...rest}
        aria-describedby={wiring.describedBy}
      />
      <span className="mrd-choice__indicator mrd-choice__indicator--box" aria-hidden="true">
        <svg className="mrd-choice__check" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3.9 8.3 6.4 10.8l5.7-5.9" />
        </svg>
        <svg className="mrd-choice__mixed" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M4.4 8h7.2" />
        </svg>
      </span>
      {label != null || description != null ? (
        <span className="mrd-choice__text">
          {label != null ? <span className="mrd-choice__label">{label}</span> : null}
          {description != null ? (
            <span className="mrd-choice__description" id={wiring.descriptionId}>
              {description}
            </span>
          ) : null}
        </span>
      ) : null}
    </label>
  );
});

interface RadioGroupContextValue {
  name: string;
  value: string;
  disabled?: boolean;
  onSelect: (value: string) => void;
}

const RadioGroupContext = createContext<RadioGroupContextValue | null>(null);

export interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  value: string;
  label?: ReactNode;
  description?: ReactNode;
}

export const Radio = forwardRef<HTMLInputElement, RadioProps>(function Radio(
  { value, label, description, className, disabled, id, name, checked, onChange, ...rest },
  ref,
) {
  const group = useContext(RadioGroupContext);
  const wiring = useControlWiring({
    id,
    ariaLabel: rest['aria-label'],
    ariaLabelledBy: rest['aria-labelledby'],
    ariaDescribedBy: rest['aria-describedby'],
    description,
    selfLabelled: label != null,
  });
  const isDisabled = disabled || group?.disabled;

  return (
    <label className={cx('mrd-choice', 'mrd-choice--radio', className)} data-disabled={isDisabled || undefined}>
      <input
        ref={ref}
        id={wiring.controlId}
        type="radio"
        className="mrd-choice__input mrd-sr-only"
        name={name ?? group?.name}
        value={value}
        checked={checked ?? (group ? group.value === value : undefined)}
        disabled={isDisabled}
        aria-labelledby={wiring.labelledBy}
        onChange={(event) => {
          if (event.target.checked) group?.onSelect(value);
          onChange?.(event);
        }}
        {...rest}
        aria-describedby={wiring.describedBy}
      />
      <span className="mrd-choice__indicator mrd-choice__indicator--dot" aria-hidden="true">
        <span className="mrd-choice__dot" />
      </span>
      {label != null || description != null ? (
        <span className="mrd-choice__text">
          {label != null ? <span className="mrd-choice__label">{label}</span> : null}
          {description != null ? (
            <span className="mrd-choice__description" id={wiring.descriptionId}>
              {description}
            </span>
          ) : null}
        </span>
      ) : null}
    </label>
  );
});

export interface RadioGroupProps {
  /** Shared input name. Generated when omitted. */
  name?: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  label?: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  orientation?: 'vertical' | 'horizontal';
  disabled?: boolean;
  required?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * The group owns the selection so its Radios never flip between controlled and
 * uncontrolled. Arrow-key roving comes from the browser, which already treats
 * same-named radios as one tab stop.
 */
export function RadioGroup({
  name,
  value,
  defaultValue,
  onValueChange,
  label,
  description,
  error,
  orientation = 'vertical',
  disabled,
  required,
  className,
  children,
}: RadioGroupProps): React.JSX.Element {
  const uid = useId();
  const [internal, setInternal] = useState(() => defaultValue ?? '');
  const current = value ?? internal;
  const labelId = label != null ? `${uid}-label` : undefined;
  const descriptionId = description ? `${uid}-description` : undefined;
  const errorId = error ? `${uid}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(' ') || undefined;

  const context = useMemo<RadioGroupContextValue>(
    () => ({
      name: name ?? uid,
      value: current,
      disabled,
      onSelect: (next: string) => {
        if (value === undefined) setInternal(next);
        onValueChange?.(next);
      },
    }),
    [current, disabled, name, onValueChange, uid, value],
  );

  return (
    <div className={cx('mrd-radio-group', className)}>
      {label != null ? (
        <span className="mrd-radio-group__label" id={labelId}>
          {label}
          {required ? (
            <span className="mrd-required-mark" aria-hidden="true">
              *
            </span>
          ) : null}
        </span>
      ) : null}
      <div
        role="radiogroup"
        className={cx('mrd-radio-group__options', orientation === 'horizontal' && 'mrd-radio-group__options--horizontal')}
        aria-labelledby={labelId}
        aria-describedby={describedBy}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
      >
        <RadioGroupContext.Provider value={context}>{children}</RadioGroupContext.Provider>
      </div>
      <FieldNotes description={description} descriptionId={descriptionId} error={error} errorId={errorId} />
    </div>
  );
}

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'type' | 'value'> {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  /** Visible text. Omit inside a FormRow, whose label already names the switch. */
  label?: ReactNode;
}

/**
 * role="switch" rather than a checkbox: the two states are on and off, not
 * selected and unselected, and the knob's position — not its colour — is what
 * reports which one is current.
 */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, defaultChecked = false, onCheckedChange, label, className, disabled, id, onClick, ...rest },
  ref,
) {
  const uid = useId();
  const [internal, setInternal] = useState(defaultChecked);
  const on = checked ?? internal;
  const labelId = label != null ? `${uid}-label` : undefined;
  const wiring = useControlWiring({
    id,
    ariaLabel: rest['aria-label'],
    ariaLabelledBy: rest['aria-labelledby'] ?? labelId,
    ariaDescribedBy: rest['aria-describedby'],
  });

  const control = (
    <button
      ref={ref}
      id={wiring.controlId}
      type="button"
      role="switch"
      className={cx('mrd-switch', label == null && className)}
      aria-checked={on}
      aria-labelledby={wiring.labelledBy}
      disabled={disabled}
      onClick={(event) => {
        if (checked === undefined) setInternal(!on);
        onCheckedChange?.(!on);
        onClick?.(event);
      }}
      {...rest}
      aria-describedby={wiring.describedBy}
    >
      <span className="mrd-switch__knob" />
    </button>
  );

  if (label == null) return control;
  return (
    <span className={cx('mrd-switch-field', className)} data-disabled={disabled || undefined}>
      {control}
      <span className="mrd-switch-field__label" id={labelId}>
        {label}
      </span>
    </span>
  );
});

export interface SliderProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size' | 'value' | 'defaultValue'> {
  value?: number;
  defaultValue?: number;
  min?: number;
  max?: number;
  step?: number;
  onValueChange?: (value: number) => void;
  /** Shows the current value beside the track. */
  showValue?: boolean;
  /** Also becomes aria-valuetext, so "8,192 tokens" is announced, not "8192". */
  formatValue?: (value: number) => string;
  invalid?: boolean;
  description?: ReactNode;
  error?: ReactNode;
  fullWidth?: boolean;
}

export const Slider = forwardRef<HTMLInputElement, SliderProps>(function Slider(
  {
    value,
    defaultValue,
    min = 0,
    max = 100,
    step = 1,
    onValueChange,
    onChange,
    showValue = false,
    formatValue,
    invalid,
    description,
    error,
    fullWidth = true,
    className,
    disabled,
    id,
    style,
    ...rest
  },
  ref,
) {
  const [internal, setInternal] = useState(() => defaultValue ?? min);
  const current = value ?? internal;
  const wiring = useControlWiring({
    id,
    ariaLabel: rest['aria-label'],
    ariaLabelledBy: rest['aria-labelledby'],
    ariaDescribedBy: rest['aria-describedby'],
    invalid,
    description,
    error,
  });
  const progress = max > min ? ((current - min) / (max - min)) * 100 : 0;
  const text = formatValue ? formatValue(current) : String(current);

  return (
    <div className={cx('mrd-field-control', fullWidth && 'mrd-field-control--full', className)}>
      <div className="mrd-slider">
        <input
          ref={ref}
          id={wiring.controlId}
          type="range"
          className="mrd-slider__input"
          min={min}
          max={max}
          step={step}
          value={current}
          disabled={disabled}
          aria-valuetext={formatValue ? text : undefined}
          aria-invalid={wiring.invalid || undefined}
          aria-labelledby={wiring.labelledBy}
          style={{ ...style, '--mrd-slider-progress': `${progress}%` } as CSSProperties}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (value === undefined) setInternal(next);
            onValueChange?.(next);
            onChange?.(event);
          }}
          {...rest}
          aria-describedby={wiring.describedBy}
        />
        {showValue ? (
          // The range already announces its value; a second reading of the same
          // number would only be noise.
          <span className="mrd-slider__value mrd-numeric" aria-hidden="true">
            {text}
          </span>
        ) : null}
      </div>
      <FieldNotes description={description} descriptionId={wiring.descriptionId} error={error} errorId={wiring.errorId} />
    </div>
  );
});

export interface FieldProps {
  label: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  /** Point the label at a control that brings its own id. */
  htmlFor?: string;
  className?: string;
  id?: string;
  /** A single control. Two controls in one Field would share one id. */
  children: ReactNode;
}

/**
 * Label above, control, then help or error — the vertical form building block.
 * An error here also marks the control invalid, so the two never disagree.
 */
export function Field({ label, description, error, required, htmlFor, className, id, children }: FieldProps): React.JSX.Element {
  const uid = useId();
  const controlId = htmlFor ?? `${uid}-control`;
  const labelId = `${uid}-label`;
  const descriptionId = description ? `${uid}-description` : undefined;
  const errorId = error ? `${uid}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(' ') || undefined;
  const context = useMemo<FormControlContextValue>(
    () => ({ controlId, labelId, describedBy, invalid: Boolean(error), required }),
    [controlId, labelId, describedBy, error, required],
  );

  return (
    <div className={cx('mrd-field', className)} id={id}>
      <label className="mrd-field__label" id={labelId} htmlFor={controlId}>
        {label}
        {required ? (
          <span className="mrd-required-mark" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      <FormControlContext.Provider value={context}>{children}</FormControlContext.Provider>
      <FieldNotes description={description} descriptionId={descriptionId} error={error} errorId={errorId} />
    </div>
  );
}

export interface FormRowProps {
  label: ReactNode;
  description?: ReactNode;
  required?: boolean;
  /** Aligns the control to the first line when the description runs long. */
  align?: 'center' | 'start';
  className?: string;
  id?: string;
  /** The control that sits on the right. */
  children?: ReactNode;
}

/**
 * The settings row: text on the left, control on the right, hairline between
 * consecutive rows. The label is a <span> rather than a <label> because the
 * control on the right is as often a button — a Switch — as a native input,
 * and a <label for> pointed at a button names nothing; aria-labelledby works
 * for both.
 */
export function FormRow({ label, description, required, align = 'center', className, id, children }: FormRowProps): React.JSX.Element {
  const uid = useId();
  const labelId = `${uid}-label`;
  const descriptionId = description ? `${uid}-description` : undefined;
  const context = useMemo<FormControlContextValue>(
    () => ({ controlId: `${uid}-control`, labelId, describedBy: descriptionId, required }),
    [descriptionId, labelId, required, uid],
  );

  return (
    <div className={cx('mrd-form-row', align === 'start' && 'mrd-form-row--start', className)} id={id}>
      <span className="mrd-row-text">
        <span className="mrd-row-text__label" id={labelId}>
          {label}
          {required ? (
            <span className="mrd-required-mark" aria-hidden="true">
              *
            </span>
          ) : null}
        </span>
        {description != null ? (
          <span className="mrd-row-text__description" id={descriptionId}>
            {description}
          </span>
        ) : null}
      </span>
      {children != null ? (
        <span className="mrd-form-row__control">
          <FormControlContext.Provider value={context}>{children}</FormControlContext.Provider>
        </span>
      ) : null}
    </div>
  );
}

export interface DisclosureRowProps {
  label: ReactNode;
  description?: ReactNode;
  /** A summary of the current setting, shown before the chevron. */
  value?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  id?: string;
  children: ReactNode;
}

/**
 * A settings row that opens to reveal the detail behind it. The panel is
 * `hidden` while closed rather than merely collapsed, so its controls leave the
 * tab order along with the pixels.
 */
export function DisclosureRow({
  label,
  description,
  value,
  open,
  defaultOpen = false,
  onOpenChange,
  className,
  id,
  children,
}: DisclosureRowProps): React.JSX.Element {
  const uid = useId();
  const [internal, setInternal] = useState(defaultOpen);
  const isOpen = open ?? internal;
  const panelId = `${uid}-panel`;

  return (
    <div className={cx('mrd-disclosure-row', className)} id={id} data-open={isOpen || undefined}>
      <button
        type="button"
        className="mrd-disclosure-row__header"
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={() => {
          if (open === undefined) setInternal(!isOpen);
          onOpenChange?.(!isOpen);
        }}
      >
        <span className="mrd-row-text">
          <span className="mrd-row-text__label">{label}</span>
          {description != null ? <span className="mrd-row-text__description">{description}</span> : null}
        </span>
        {value != null ? <span className="mrd-disclosure-row__value">{value}</span> : null}
        <span className="mrd-disclosure-row__chevron">
          <ChevronGlyph />
        </span>
      </button>
      <div id={panelId} className="mrd-disclosure-row__panel" hidden={!isOpen}>
        {children}
      </div>
    </div>
  );
}

export interface FieldsetProps {
  title?: ReactNode;
  /** Explanatory text under the group, the way desktop settings annotate one. */
  footnote?: ReactNode;
  /** Disables every control inside, natively. */
  disabled?: boolean;
  className?: string;
  id?: string;
  children: ReactNode;
}

/**
 * Related rows collected into one rounded card. A real <fieldset> so the title
 * is announced as the group's name, with the card drawn on an inner element —
 * fieldset's own border box is not a shape worth fighting.
 */
export function Fieldset({ title, footnote, disabled, className, id, children }: FieldsetProps): React.JSX.Element {
  return (
    <fieldset className={cx('mrd-fieldset', className)} id={id} disabled={disabled}>
      {title != null ? <legend className="mrd-fieldset__title">{title}</legend> : null}
      <div className="mrd-fieldset__group">{children}</div>
      {footnote != null ? <p className="mrd-fieldset__footnote">{footnote}</p> : null}
    </fieldset>
  );
}
