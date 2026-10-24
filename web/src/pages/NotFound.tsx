import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <section className="page narrow">
      <h1>No page here</h1>
      <p className="lede">This address does not match a Roadalyx page.</p>
      <p><Link className="btn primary" to="/">Back to the overview</Link></p>
    </section>
  );
}
