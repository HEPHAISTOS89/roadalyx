// Fallback for unknown paths, with a way back to the district map.
import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <section className="page narrow">
      <h1>Page not found</h1>
      <p><Link className="btn primary" to="/district-map">District map</Link></p>
    </section>
  );
}
