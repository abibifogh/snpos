import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ToastHost } from '@snpos/ui';
import '@snpos/ui/src/styles.css';
import './admin.css';
import { App } from './App';
import { SessionProvider } from './session';

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
