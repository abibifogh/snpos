import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ToastHost, applyFavicon, guardStaleBuild, bootedOk } from '@snpos/ui';
import '@snpos/ui/src/styles.css';
import './menu.css';
import { App } from './App';

// A deploy can land while this page is open; recover rather than go blank.
guardStaleBuild();

// Draw the tab icon from the default colours straight away; it is redrawn
// with the restaurant's own colours as soon as settings load.
applyFavicon();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastHost>
      <App />
    </ToastHost>
  </StrictMode>,
);

bootedOk();
