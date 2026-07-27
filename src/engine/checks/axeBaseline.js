import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AXE_CORE_PATH = require.resolve('axe-core/axe.min.js');

/**
 * Independent cross-check using axe-core (bundled locally, not fetched from
 * a CDN — avoids version drift and works offline). Its findings should
 * overlap heavily with the bespoke checks; large unexplained gaps are a
 * signal that a bespoke check has a bug, not that axe is wrong.
 */
export async function auditAxeBaseline(page) {
  await page.addScriptTag({ path: AXE_CORE_PATH });
  return page.evaluate(async () => {
    const { violations } = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    });
    return violations.map((v) => ({
      rule: v.id,
      impact: v.impact,
      help: v.help,
      nodesCount: v.nodes.length,
      nodes: v.nodes.slice(0, 15).map((n) => ({ target: n.target.join(' '), html: n.html.slice(0, 200) })),
    }));
  });
}
