import './styles/base.css';
import './styles/dashboard.css';
import './styles/records.css';
import './styles/shell.css';
import './styles/imports.css';
import './styles/responsive.css';
import './styles/motion.css';
import './styles/analysis-workspace.css';
import { createApp } from './app.js';

createApp();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
      .catch(error => console.warn('Service worker registration failed', error));
  });
}
