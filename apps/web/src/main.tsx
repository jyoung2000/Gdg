import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './shell/App.js';
import '@meridian/ui/styles.css';
import './app.css';
import './screens/workspace.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
