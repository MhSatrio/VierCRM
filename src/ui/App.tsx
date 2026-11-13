import React, { lazy, Suspense, useEffect, useState } from 'react';
import * as S from '../core/store';
import { templateById } from '../core/defaults';
import { announceBases, ErrorBoundary, ToastProvider, useBases, wireChanges } from './bridge';
import { AddBaseModal } from './components/AddBase';

// Every page is its own small chunk: the shell opens immediately and a page's code is read only when it is visited.
const TableView = lazy(() => import('./components/TableView').then(m => ({ default: m.TableView })));
const Dashboard = lazy(() => import('./pages/Home').then(m => ({ default: m.Dashboard })));
const Bases = lazy(() => import('./pages/Home').then(m => ({ default: m.Bases })));
const Scraper = lazy(() => import('./pages/Scraper').then(m => ({ default: m.ScraperPage })));
const Research = lazy(() => import('./pages/Research').then(m => ({ default: m.Research })));
const Automations = lazy(() => import('./pages/Automations').then(m => ({ default: m.Automations })));
const Email = lazy(() => import('./pages/Email').then(m => ({ default: m.Email })));
const Analytics = lazy(() => import('./pages/Email').then(m => ({ default: m.Analytics })));
const SettingsPage = lazy(() => import('./pages/Settings').then(m => ({ default: m.SettingsPage })));

const TOOLS: [string, string, string][] = [['scraper', 'Scraper', '⌖'], ['research', 'Research Finder', '✦'], ['automations', 'Automations', '⚡'], ['email', 'Email Campaigns', '✉'], ['analytics', 'Analytics', '▤']];
const route = () => location.hash.replace(/^#\/?/, '').split('?')[0];
const Loading = () => <div className="main muted">Loading…</div>;

export function App() {
  const [ready, setReady] = useState(false); const [r, setR] = useState(route()); const [adding, setAdding] = useState(false);
  useEffect(() => { wireChanges(); void S.ensureSeeded().then(() => { announceBases(); setReady(true); }); const h = () => setR(route()); window.addEventListener('hashchange', h); return () => window.removeEventListener('hashchange', h); }, []);
  const { tables, counts, ready: basesReady } = useBases();
  if (!ready) return <div className="main muted">Loading VierCRM…</div>;

  // #/base/<id>   (older links: #/contacts, #/db/<id>)
  const baseId = r.startsWith('base/') ? r.slice(5) : r.startsWith('db/') ? r.slice(3) : r === 'contacts' ? tables[0]?.id : '';
  const page = baseId ? (basesReady && !tables.some(t => t.id === baseId) ? <div className="main"><div className="note warn">That base no longer exists. Pick one from the list on the left.</div></div> : <TableView tableId={baseId} key={baseId} title={tables.find(t => t.id === baseId)?.name} />)
    : r === '' ? <Dashboard /> : r === 'bases' || r === 'databases' ? <Bases /> : r === 'scraper' ? <Scraper /> : r === 'research' ? <Research /> : r === 'automations' ? <Automations /> : r === 'email' ? <Email /> : r === 'analytics' ? <Analytics /> : r === 'settings' ? <SettingsPage /> : <Dashboard />;
  const on = (k: string) => (k === '' ? r === '' : k === 'bases' ? r === 'bases' || r === 'databases' : r === k);
  const link = (k: string, label: string, icon: string, extra?: React.ReactNode) => <a key={k} href={`#/${k}`} className={on(k) ? 'on' : ''} aria-current={on(k) ? 'page' : undefined}><span className="ico" aria-hidden>{icon}</span>{label}{extra}</a>;
  return (
    <ToastProvider><div className="shell">
      <aside className="side">
        <div className="brand"><img src="brand/vier-black.svg" alt="VierApparatus" /><span className="eyebrow">CRM</span></div>
        <nav className="nav" aria-label="Main">
          {link('', 'Dashboard', '▦')}
          <div className="sec"><span className="eyebrow">Bases</span></div>
          {tables.map(t => { const k = `base/${t.id}`; const active = baseId === t.id; return <a key={t.id} href={`#/${k}`} className={active ? 'on' : ''} aria-current={active ? 'page' : undefined}><span className="ico" aria-hidden>{templateById(t.template).icon}</span><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span><span className="n">{(counts[t.id] ?? 0).toLocaleString()}</span></a>; })}
          <button className="add" onClick={() => setAdding(true)}>＋ Add base</button>
          <div className="sec"><span className="eyebrow">Tools</span></div>
          {TOOLS.map(([k, l, i]) => link(k, l, i))}
          <div className="sec"><span className="eyebrow">Manage</span></div>
          {link('bases', 'Manage bases', '⚙︎')}{link('settings', 'Settings', '⚙')}
        </nav>
        <div style={{ marginTop: 'auto', padding: 8, fontSize: 12, color: 'var(--muted)' }}>Data stays in this browser</div>
      </aside>
      <main className="app-main"><ErrorBoundary resetKey={r}><Suspense fallback={<Loading />}>{page}</Suspense></ErrorBoundary></main>
      {adding && <AddBaseModal onClose={() => setAdding(false)} onCreated={t => { location.hash = `#/base/${t.id}`; }} />}
    </div></ToastProvider>
  );
}
