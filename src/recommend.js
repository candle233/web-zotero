'use strict';

function tokenize(value) {
  return String(value || '').toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [];
}

function recommend(items, activeKey, limit = 8) {
  const active = items.find(item => item.key === activeKey);
  if (!active) return [];
  const activeTerms = new Set(tokenize(`${active.title} ${active.creators.join(' ')}`));
  const scored = items.filter(item => item.key !== activeKey).map(item => {
    const terms = tokenize(`${item.title} ${item.creators.join(' ')}`);
    if (!terms.length) return { item, score: 0 };
    const overlap = terms.reduce((total, term) => total + (activeTerms.has(term) ? 1 : 0), 0);
    return { item, score: overlap / Math.sqrt(terms.length) };
  }).filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ item }) => ({ ...item }));
  return scored;
}

module.exports = { recommend };
