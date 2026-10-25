import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import Shell from '../src/components/Shell';

const render = (path: string) => renderToStaticMarkup(
  <MemoryRouter initialEntries={[path]}><Shell><h1>Page content</h1></Shell></MemoryRouter>,
);

describe('portal navigation', () => {
  it('keeps only the two analyst views in the main navigation', () => {
    for (const path of ['/analysis', '/district-map']) {
      const nav = render(path).match(/<nav[^>]*>(.*?)<\/nav>/)?.[1] ?? '';
      expect((nav.match(/<a /g) ?? [])).toHaveLength(2);
      expect(nav).toContain('District map');
      expect(nav).toContain('Analysis');
      expect(nav).not.toContain('Data access');
      expect(nav).not.toContain('API docs');
    }
  });

  it('places the direct API docs link in the Analysis footer, alongside the existing resources', () => {
    const footer = render('/analysis').match(/<footer[^>]*>(.*?)<\/footer>/)?.[1] ?? '';
    expect(footer).toContain('<a href="/api/docs">API docs</a>');
    expect(footer).toContain('EDA notebook');
    expect(footer).toContain('Source code');
    expect(render('/district-map')).not.toContain('<footer');
  });
});
