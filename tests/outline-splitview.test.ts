import test from 'node:test';
import assert from 'node:assert/strict';
import { countOutlineNodes, resolvePdfOutline, formatQuoteHtml } from '../src/pdf/outline.ts';
import type { OutlineNode } from '../src/pdf/types.ts';

test('countOutlineNodes correctly counts flat and nested TOC nodes', () => {
  const flatNodes: OutlineNode[] = [
    { title: 'Chapter 1', dest: null, pageIndex: 0, items: [] },
    { title: 'Chapter 2', dest: null, pageIndex: 10, items: [] },
  ];
  assert.equal(countOutlineNodes(flatNodes), 2);

  const nestedNodes: OutlineNode[] = [
    {
      title: 'Chapter 1: Introduction',
      dest: null,
      pageIndex: 0,
      items: [
        { title: '1.1 Motivation', dest: null, pageIndex: 1, items: [] },
        { title: '1.2 Contributions', dest: null, pageIndex: 2, items: [] },
      ],
    },
    {
      title: 'Chapter 2: Related Work',
      dest: null,
      pageIndex: 4,
      items: [
        {
          title: '2.1 Classical Methods',
          dest: null,
          pageIndex: 5,
          items: [
            { title: '2.1.1 Heuristics', dest: null, pageIndex: 6, items: [] },
          ],
        },
      ],
    },
  ];
  assert.equal(countOutlineNodes(nestedNodes), 6);
});

test('resolvePdfOutline resolves raw PDF outline items with named and numeric destinations', async () => {
  const mockDoc: any = {
    getDestination: async (name: string) => {
      if (name === 'named-ch1') return [{ num: 101, gen: 0 }, { name: 'XYZ' }, 0, 0, 0];
      if (name === 'named-ch2') return [{ num: 102, gen: 0 }, { name: 'XYZ' }, 0, 0, 0];
      return null;
    },
    getPageIndex: async (ref: { num: number; gen: number }) => {
      if (ref.num === 101) return 0;
      if (ref.num === 102) return 5;
      return 0;
    },
  };

  const rawOutline = [
    {
      title: 'Introduction',
      dest: 'named-ch1',
      items: [
        {
          title: 'Background',
          dest: [1, { name: 'Fit' }], // numeric 0-indexed page index 1
          items: [],
        },
      ],
    },
    {
      title: 'Methodology',
      dest: 'named-ch2',
      items: [],
    },
  ];

  const resolved = await resolvePdfOutline(mockDoc, rawOutline);
  assert.equal(resolved.length, 2);
  assert.equal(resolved[0].title, 'Introduction');
  assert.equal(resolved[0].pageIndex, 0);
  assert.equal(resolved[0].items.length, 1);
  assert.equal(resolved[0].items[0].title, 'Background');
  assert.equal(resolved[0].items[0].pageIndex, 1);

  assert.equal(resolved[1].title, 'Methodology');
  assert.equal(resolved[1].pageIndex, 5);
});

test('Quote-to-Note HTML generation formats page anchors correctly', () => {
  const quoteText = 'Deep learning enables hierarchical feature representations.';
  const pageIndex = 4; // 0-based, corresponds to page 5

  const quoteHtml = formatQuoteHtml(quoteText, pageIndex);

  assert.ok(quoteHtml.includes('data-page="5"'));
  assert.ok(quoteHtml.includes('href="#page=5"'));
  assert.ok(quoteHtml.includes('Deep learning enables hierarchical feature representations.'));
});
