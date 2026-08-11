import { useEffect, useState } from 'react';

/**
 * Says, plainly, when the app is working without a connection.
 *
 * The worst version of offline support is the silent one: staff carry on, the
 * writes queue up, and nobody finds out until the next morning that half a
 * service is sitting on one iPad. So this is deliberately loud while offline,
 * and stays visible until the last queued write has actually landed.
 */
export function OfflineBar({
  queued,
  onRetry,
}: {
  /** How many writes are waiting to be sent. */
  queued: number;
  onRetry?: () => void;
}) {
  const [online, setOnline] = useState(() => navigator.onLine !== false);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  if (online && queued === 0) return null;

  return (
    <div className={`offline-bar ${online ? 'syncing' : ''}`} role="status" aria-live="polite">
      <span className="dot" aria-hidden="true" />
      <span>
        {!online ? (
          <>
            <strong>No connection.</strong>{' '}
            {queued > 0
              ? `Still working, ${queued} ${queued === 1 ? 'change is' : 'changes are'} saved on this device and will send when you are back.`
              : 'Still working. Anything you do is saved here and sent when you are back.'}
          </>
        ) : (
          <>
            <strong>Catching up.</strong> Sending {queued} {queued === 1 ? 'change' : 'changes'} saved while you were
            offline.
          </>
        )}
      </span>
      {online && queued > 0 && onRetry && (
        <button className="offline-retry" onClick={onRetry}>Try now</button>
      )}
    </div>
  );
}
