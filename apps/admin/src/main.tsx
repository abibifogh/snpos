import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { ErrorBoundary, applyThemeMode, enableOffline, ToastHost, applyFavicon, guardStaleBuild, bootedOk } from '@snpos/ui';
import { configureOrg } from '@snpos/core';
import '@snpos/ui/src/styles.css';
import './admin.css';
import { App } from './App';
import { SessionProvider } from './session';

// A deploy can land while this page is open; recover rather than go blank.
guardStaleBuild();

// Draw the tab icon from the default colours straight away; it is redrawn
// with the restaurant's own colours as soon as settings load.
applyFavicon();

// The saved light/dark choice, before first paint, otherwise the page
// flashes the wrong colours on the way in.
applyThemeMode();

// Cache the app so it opens with no connection at all. Writes made while
// offline are queued by @snpos/core and sent when the signal returns.
enableOffline();

// One restaurant, for now.
//
// This says out loud that the app is not yet reading a hotel's identity from
// the session, so no query is filtered by organisation, exactly as it has
// always behaved. Every read refuses outright until this has been called,
// which is the point: the state that must never exist is "nobody said which
// hotel, and the data came back anyway".
//
// When the multi-hotel switch-over lands, this becomes a lookup against the
// signed-in person's team and the line below goes.
configureOrg({ mode: 'single' });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary label="admin">
      {/* Hash routing, not path routing. GitHub Pages serves files, so a refresh
          on /admin/settings asks for a file that does not exist and gets GitHub's
          own "There isn't a GitHub Pages site here". A #/settings never leaves
          the server, so refresh, back and bookmarks all work. */}
      <HashRouter>
        <ToastHost>
          <SessionProvider>
            <App />
          </SessionProvider>
        </ToastHost>
      </HashRouter>
    </ErrorBoundary>
  </StrictMode>,
);

bootedOk();
