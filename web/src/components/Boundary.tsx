// Error boundary around every page.
import { Component, type ReactNode } from 'react';

/**
 * Catches render errors and failed page loads. The usual cause in production is a redeploy while
 * a tab is open: the old page asks for a script file that no longer exists, and a reload fixes it.
 */
export default class Boundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    if (!this.state.error) return this.props.children;
    const stale = /dynamically imported module|Importing a module script failed|error loading dynamically/i.test(this.state.error.message);
    return (
      <section className="page narrow" role="alert">
        <h1>{stale ? 'A newer version is available' : 'This view failed to load'}</h1>
        <p className="lede">{stale ? 'Roadalyx was updated while this tab was open.' : this.state.error.message}</p>
        <p><button type="button" className="btn primary" onClick={() => window.location.reload()}>Reload the page</button></p>
      </section>
    );
  }
}
