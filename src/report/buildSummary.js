/**
 * Reduces the raw per-page results into (a) a scorecard of hard-fail counts
 * per SOW item, (b) a "needs a human eye" bucket kept separate from failures
 * so it never inflates or hides in the fail count, and (c) a cross-page
 * table of which pages share each failure type — the site-wide items
 * (contrast tokens, nav, footer) only need calling out once instead of once
 * per page.
 */
export function buildSummary(pageResults) {
  const ok = pageResults.filter((r) => !r.error);
  const errored = pageResults.filter((r) => r.error);

  const perCheckPages = {
    contrastFailures: [],
    keyboardInvisibleFocus: [],
    dropdownFailures: [],
    focusableButHidden: [],
    focusNoIndicator: [],
    focusWeakIndicator: [],
    altMissingAttr: [],
    altFilenameAsAlt: [],
    altLinkedNoName: [],
    headingSkips: [],
    headingMissingTitle: [],
    headingMultipleH1: [],
    ariaNoName: [],
    ariaLabelInName: [],
    ariaInputNoLabel: [],
    ariaNoAutocomplete: [],
    ariaExpandedBad: [],
    ariaDuplicateIds: [],
    axeViolations: [],
  };

  const totals = Object.fromEntries(Object.keys(perCheckPages).map((k) => [k, 0]));
  let manualReviewCount = 0;

  ok.forEach((r) => {
    const add = (key, condition) => {
      if (condition) perCheckPages[key].push(r.url);
    };

    totals.contrastFailures += r.contrast.failures.length;
    add('contrastFailures', r.contrast.failures.length > 0);
    manualReviewCount += r.contrast.manualReview.length;

    totals.keyboardInvisibleFocus += r.keyboard.tabOrder.invisibleStops.length;
    add('keyboardInvisibleFocus', r.keyboard.tabOrder.invisibleStops.length > 0);

    totals.dropdownFailures += r.keyboard.dropdowns.failingCount;
    add('dropdownFailures', r.keyboard.dropdowns.failingCount > 0);

    totals.focusableButHidden += r.keyboard.focusableHidden.focusableButHidden.length;
    add('focusableButHidden', r.keyboard.focusableHidden.focusableButHidden.length > 0);

    totals.focusNoIndicator += r.focusState.noIndicator.length;
    add('focusNoIndicator', r.focusState.noIndicator.length > 0);
    totals.focusWeakIndicator += r.focusState.weakIndicator.length;
    add('focusWeakIndicator', r.focusState.weakIndicator.length > 0);

    totals.altMissingAttr += r.altText.noAttr.length;
    add('altMissingAttr', r.altText.noAttr.length > 0);
    totals.altFilenameAsAlt += r.altText.filenameAsAlt.length;
    add('altFilenameAsAlt', r.altText.filenameAsAlt.length > 0);
    totals.altLinkedNoName += r.altText.linkedNoName.length;
    add('altLinkedNoName', r.altText.linkedNoName.length > 0);
    manualReviewCount += r.altText.reviewEmptyAlt.length;

    totals.headingSkips += r.headings.skips.length;
    add('headingSkips', r.headings.skips.length > 0);
    add('headingMissingTitle', !r.headings.pageTitle);
    add('headingMultipleH1', r.headings.visibleH1Count > 1);

    totals.ariaNoName += r.aria.noName.length;
    add('ariaNoName', r.aria.noName.length > 0);
    totals.ariaLabelInName += r.aria.labelInName.length;
    add('ariaLabelInName', r.aria.labelInName.length > 0);
    totals.ariaInputNoLabel += r.aria.inputNoLabel.length;
    add('ariaInputNoLabel', r.aria.inputNoLabel.length > 0);
    totals.ariaNoAutocomplete += r.aria.noAutocomplete.length;
    add('ariaNoAutocomplete', r.aria.noAutocomplete.length > 0);
    totals.ariaExpandedBad += r.aria.ariaExpandedBad.length;
    add('ariaExpandedBad', r.aria.ariaExpandedBad.length > 0);
    totals.ariaDuplicateIds += r.aria.duplicateIds.length;
    add('ariaDuplicateIds', r.aria.duplicateIds.length > 0);

    const axeCount = Array.isArray(r.axe.violations) ? r.axe.violations.length : 0;
    totals.axeViolations += axeCount;
    add('axeViolations', axeCount > 0);
  });

  return {
    pagesAudited: ok.length,
    pagesErrored: errored.length,
    erroredUrls: errored.map((r) => r.url),
    totals,
    manualReviewCount,
    perCheckPages,
  };
}
