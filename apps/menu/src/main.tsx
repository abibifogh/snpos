import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary, applyThemeMode, ToastHost, applyFavicon, guardStaleBuild, bootedOk } from '@snpos/ui';
import '@snpos/ui/src/styles.css';
import './menu.css';
import { App } from './App';

// A deploy can land while this page is open; recover rather than go blank.
guardStaleBuild();

// Draw the tab icon from the default colours straight away; it is redrawn
// with the restaurant's own colours as soon as settings load.
applyFavicon();

// The saved light/dark choice, before first paint — otherwise the page
// flashes the wrong colours on the way in.
applyThemeMode();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary label="menu">
      <ToastHost>
        <App />
      </ToastHost>
    </ErrorBoundary>
  </StrictMode>,
);

bootedOk();
