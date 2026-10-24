import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/app.css';
import Boundary from './components/Boundary';
import Shell from './components/Shell';
import Home from './pages/Home';
import NotFound from './pages/NotFound';

// Load the Explorer map on demand so the landing page stays light.
const Explorer = lazy(() => import('./pages/Explorer'));

function Pages() {
  const { pathname } = useLocation();
  return (
    <Boundary resetKey={pathname}>
      <Suspense fallback={<div className="page-loading" role="status">Loading…</div>}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/explorer" element={<Explorer />} />
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
