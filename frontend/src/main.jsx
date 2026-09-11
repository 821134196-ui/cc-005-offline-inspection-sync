import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import { store } from './offline/store.js';
import { registerSW } from 'virtual:pwa-register';

registerSW({ immediate: true });

// Make sure an authenticated session resumes background sync after a browser
// restart as soon as the app shell mounts.
(async () => {
  store.startTicker();
  if (navigator.onLine) store.requestSync();
})();

createRoot(document.getElementById('root')).render(<App />);
