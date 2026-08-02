import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ToastHost, applyFavicon } from '@snpos/ui';
import '@snpos/ui/src/styles.css';
import './admin.css';
import { App } from './App';
import { SessionProvider } from './session';

// Draw the tab icon from the default colours straight away; it is redrawn
// with the restaurant's own colours as soon as settings load.
applyFavicon();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastHost>
        <SessionProvider>
          <App />
        </SessionProvider>
      </ToastHost>
    </BrowserRouter>
  </StrictMode>,
);
