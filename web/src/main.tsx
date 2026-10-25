// Entry point: fonts and styles, page-view tracking, and the two routes of the portal
// (District map and Analysis) inside the shared header/footer shell and an error boundary.
import { StrictMode, Suspense, lazy, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import '@fontsource-variable/geist';
import '@fontsource/instrument-serif/latin-400-italic.css';
import './styles/tokens.css';
import './styles/app.css';
import Boundary from './components/Boundary';
import Shell from './components/Shell';
import Home from './pages/Home';
import NotFound from './pages/NotFound';
import { installTracking, trackPage } from './lib/track';

installTracking();

// Load the Analysis page (and its map) on demand so the landing page stays light.
const Explorer = lazy(() => import('./pages/Explorer'));

// Routes, wrapped so a failed page load shows a reload prompt instead of a blank screen;
// resetKey clears that error when the visitor navigates elsewhere.
function Pages() {
  const { pathname, search } = useLocation();
  useEffect(trackPage, [pathname, search]);
  return (
    <Boundary resetKey={pathname}>
      <Suspense fallback={<div className="page-loading" role="status">Loading…</div>}>
        <Routes>
          <Route path="/" element={<Navigate to="/district-map" replace />} />
          <Route path="/district-map" element={<Home />} />
          <Route path="/analysis" element={<Explorer />} />
          {/* The page was called Explorer at first: old links keep working, filters included. */}
          <Route path="/explorer" element={<Navigate to={`/analysis${search}`} replace />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </Boundary>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Shell>
        <Pages />
      </Shell>
    </BrowserRouter>
  </StrictMode>,
);
