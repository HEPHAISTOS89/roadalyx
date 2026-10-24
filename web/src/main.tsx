import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/app.css';
import Shell from './components/Shell';
import Home from './pages/Home';
import NotFound from './pages/NotFound';

// The Explorer (MapLibre) and Platform pages load on demand so the landing page stays light.
const Explorer = lazy(() => import('./pages/Explorer'));
const Platform = lazy(() => import('./pages/Platform'));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Shell>
        <Suspense fallback={<div className="page-loading" role="status">Loading…</div>}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/explorer" element={<Explorer />} />
            <Route path="/platform" element={<Platform />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </Shell>
    </BrowserRouter>
  </StrictMode>,
);
