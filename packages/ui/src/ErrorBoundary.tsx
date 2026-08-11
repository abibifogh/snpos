import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

/**
 * The last thing between a broken render and a blank screen.
 *
 * React unmounts the whole tree when a render throws. Without this, a mistake
 * in one sheet takes the entire app down to white, no message, no clue, and
 * nothing to tell someone standing in a kitchen whether the wifi died or the
 * software did. It has happened here more than once, so it is caught.
 *
 * Deliberately plain: no branding, no network calls. Whatever is broken, this
 * has to be the part that still works.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; label?: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Kept in the console so it can be read off a device without a debugger.
    console.error('[snpos] render failed', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div style={{ padding: '2rem 1.25rem', maxWidth: '34rem', margin: '0 auto', textAlign: 'center' }}>
        <h2 style={{ marginBottom: '0.4rem' }}>Something went wrong</h2>
        <p style={{ opacity: 0.75, lineHeight: 1.5 }}>
          This screen stopped working. Nothing you had entered was sent. Reloading usually clears it, if it keeps
          happening, show this message to whoever looks after the system.
        </p>
        <pre
          style={{
            textAlign: 'left', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '0.8rem',
            opacity: 0.7, background: 'rgba(127,127,127,0.12)', padding: '0.75rem', borderRadius: '0.5rem',
            marginTop: '1rem',
          }}
        >
          {this.props.label ? `${this.props.label}: ` : ''}{error.message}
        </pre>
        <button
          onClick={() => window.location.reload()}
          style={{
            marginTop: '1.25rem', padding: '0.7rem 1.4rem', fontSize: '1rem', borderRadius: '0.5rem',
            border: '1px solid rgba(127,127,127,0.4)', cursor: 'pointer',
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}
