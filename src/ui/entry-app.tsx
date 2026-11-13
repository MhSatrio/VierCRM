import '@fontsource/jost/latin-400.css';
import '@fontsource/jost/latin-600.css';
import './styles.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// Test hook: the end-to-end test and the benchmark open app.html?e2e to reach the same modules the UI uses. Nothing else sets this,
// and the modules are loaded only then (they would otherwise add ~55 KB of code to every start).
if (location.search.includes('e2e')) {
  void Promise.all([import('../core/store'), import('../core/db'), import('../core/settings'), import('../automation/engine'), import('../email/service'), import('../email/analytics'), import('../core/defaults'), import('../core/filters')])
    .then(([S, DB, settings, engine, mail, analytics, defaults, filters]) => { (window as any).__vier = { S, DB, settings, engine, mail, analytics, defaults, filters }; });
}
createRoot(document.getElementById('root')!).render(<App />);
