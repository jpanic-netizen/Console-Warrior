/**
 * Shared sort/search helpers for the dashboard's findings API — kept
 * separate from findings.js so they're independently unit-testable and
 * reusable for both the flat and grouped finding shapes.
 */
import { listCheckTypes } from './findings.js';

const SEVERITY_RANK = { critical: 0, serious: 1, moderate: 2, minor: 3 };
const CHECK_ORDER = new Map(listCheckTypes().map((c, i) => [c.key, i]));

function severityRank(f) {
  if (f.manualReview) return 4;
  return SEVERITY_RANK[f.severity] ?? 5;
}

function firstPage(f) {
  return f.page || (f.pages && f.pages[0]) || '';
}

export const SORT_KEYS = ['severity', 'check', 'page', 'pageCount', 'instanceCount'];

/** Sensible default direction per key — "biggest impact first" for counts, alphabetic/rank order otherwise. */
export function defaultSortDir(sortBy) {
  return sortBy === 'pageCount' || sortBy === 'instanceCount' ? 'desc' : 'asc';
}

export function sortFindings(items, sortBy = 'severity', sortDir = 'asc') {
  const dir = sortDir === 'desc' ? -1 : 1;
  return [...items].sort((a, b) => {
    let cmp = 0;
    if (sortBy === 'severity') cmp = severityRank(a) - severityRank(b);
    else if (sortBy === 'check') cmp = (CHECK_ORDER.get(a.checkKey) ?? 0) - (CHECK_ORDER.get(b.checkKey) ?? 0);
    else if (sortBy === 'page') cmp = firstPage(a).localeCompare(firstPage(b));
    else if (sortBy === 'pageCount') cmp = (a.pageCount ?? 1) - (b.pageCount ?? 1);
    else if (sortBy === 'instanceCount') cmp = (a.instanceCount ?? 1) - (b.instanceCount ?? 1);
    if (cmp === 0) cmp = (a.summary || '').localeCompare(b.summary || '');
    return cmp * dir;
  });
}

/** Case-insensitive substring match over summary, check label, and page(s). */
export function searchFindings(items, query) {
  if (!query || !query.trim()) return items;
  const q = query.trim().toLowerCase();
  return items.filter((f) => {
    const pageStr = f.page || (f.pages || []).join(' ');
    return (
      (f.summary || '').toLowerCase().includes(q) ||
      (f.checkLabel || '').toLowerCase().includes(q) ||
      pageStr.toLowerCase().includes(q)
    );
  });
}
