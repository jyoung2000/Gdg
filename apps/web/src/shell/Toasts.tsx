import { Button, IconButton, IconClose } from '@meridian/ui';
import { useStore } from '../lib/store.js';

/**
 * Application toasts.
 *
 * Errors persist until dismissed because an error the user did not see is an
 * error that will be reported as a bug; everything else clears itself so the
 * corner does not accumulate.
 */
export function Toasts(): React.JSX.Element | null {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  if (!toasts.length) return null;

  return (
    <div className="app__toasts" role="region" aria-label="Notifications">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`app-toast app-toast--${t.level}`}
          role={t.level === 'error' ? 'alert' : 'status'}
          aria-live={t.level === 'error' ? 'assertive' : 'polite'}
        >
          <div className="app-toast__body">
            <div className="app-toast__message">{t.message}</div>
            {t.detail && <div className="app-toast__detail mrd-caption">{t.detail}</div>}
          </div>
          <IconButton label="Dismiss" icon={<IconClose />} size="sm" onClick={() => dismiss(t.id)} />
        </div>
      ))}
    </div>
  );
}
