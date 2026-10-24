import { useEffect, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useApi } from '../lib/api';
import { dateLong } from '../lib/format';
import type { Meta } from '../lib/types';

export const REPO = 'https://github.com/HEPHAISTOS89/roadalyx';

export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path d="M9 25 L14.5 7 M23 25 L17.5 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="16" cy="18" r="3.4" fill="var(--sev-k)" />
    </svg>
  );
}

const TITLES: Record<string, string> = {
  '/': 'Roadalyx · Lubbock District crash analytics',
  '/explorer': 'Explorer · Roadalyx',
  '/platform': 'Platform · Roadalyx',
};

export default function Shell({ children }: { children: ReactNode }) {
  const meta = useApi<Meta>('/api/v1/meta');
  const { pathname } = useLocation();
  useEffect(() => {
    document.title = TITLES[pathname] ?? 'Not found · Roadalyx';
    window.scrollTo(0, 0);
  }, [pathname]);

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="bar">
        <Link to="/" className="brand" aria-label="Roadalyx home"><Mark /><span>Roadalyx</span></Link>
        <nav aria-label="Main">
          <NavLink to="/" end>Overview</NavLink>
          <NavLink to="/explorer">Explorer</NavLink>
          <NavLink to="/platform">Platform</NavLink>
          <a href="/api/docs">API</a>
        </nav>
        <p className="bar-data">
          {meta.data ? <>TxDOT CRIS · Lubbock District · to {dateLong(meta.data.coverage.end)}</> : meta.error ? 'Data unavailable' : ' '}
        </p>
      </header>
      <main id="main" tabIndex={-1}>{children}</main>
      <footer className="foot">
        <div>
          <p><Mark size={18} /> <b>Roadalyx</b>: injury crashes in the TxDOT Lubbock District, from a TxDOT Crash Records
            Information System (CRIS) query export provided by TransTech Lab, Texas Tech University.</p>
          <p className="muted">TxDOT makes no warranty about the accuracy of CRIS data. Counts are reported crashes with a
            K, A, B or C injury; they are not rates. County lines: US Census Bureau.</p>
        </div>
        <ul>
          <li><a href="/api/docs">API reference</a></li>
          <li><a href={`${REPO}/blob/main/notebooks/eda.ipynb`}>EDA notebook</a></li>
          <li><a href={REPO}>Source code</a></li>
        </ul>
      </footer>
    </>
  );
}
