import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { ErrorBoundary, ToastHost, applyFavicon, guardStaleBuild, bootedOk } from '@snpos/ui';
import '@snpos/ui/src/styles.css';
import './admin.css';
import { App } from './App';
import { SessionProvider } from './session';

// A deploy can land while this page is open; recover rather than go blank.
guardStaleBuild();

// Draw the tab icon from the default colours straight away; it is redrawn
// with the restaurant's own colours as soon as settings load.
applyFavicon();

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
