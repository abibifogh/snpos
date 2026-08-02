import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ToastHost } from '@snpos/ui';
import '@snpos/ui/src/styles.css';
import './menu.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastHost>
      <App />
    </ToastHost>
  </StrictMode>,
);
