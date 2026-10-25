import { useEffect, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';

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
  '/district-map': 'District map · Roadalyx',
  '/analysis': 'Analysis · Roadalyx',
};

export default function Shell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  useEffect(() => {
    document.title = TITLES[pathname] ?? 'Not found · Roadalyx';
    window.scrollTo(0, 0);
  }, [pathname]);

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="bar">
        <Link to="/district-map" className="brand" aria-label="Roadalyx home"><Mark /><span>Roadalyx</span></Link>
        <nav aria-label="Main">
          <NavLink to="/district-map">District map</NavLink>
          <NavLink to="/analysis">Analysis</NavLink>
        </nav>
      </header>
      <main id="main" tabIndex={-1}>{children}</main>
      {/* The District map is the 3D view alone; its scope line names the sources. */}
      {pathname !== '/district-map' && (
        <footer className="foot">
          <p>Data: TxDOT CRIS, Lubbock District. County lines: US Census Bureau.</p>
          <ul>
            <li><a href="/api/docs">API docs</a></li>
            <li><a href={`${REPO}/blob/main/notebooks/eda.ipynb`}>EDA notebook</a></li>
            <li><a href={REPO}>Source code</a></li>
          </ul>
        </footer>
      )}
    </>
  );
}
