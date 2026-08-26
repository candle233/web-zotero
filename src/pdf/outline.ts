import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { OutlineNode } from './types.ts';

/**
 * Recursively resolves a raw PDF outline/bookmark tree into structured OutlineNode items
 * with 0-indexed pageIndex numbers.
 */
export async function resolvePdfOutline(doc: PDFDocumentProxy, items: any[]): Promise<OutlineNode[]> {
  const result: OutlineNode[] = [];
  for (const item of items) {
    let pageIndex: number | undefined;
    try {
      let dest = item.dest;
      if (typeof dest === 'string') {
        dest = await doc.getDestination(dest);
      }
      if (Array.isArray(dest) && dest.length > 0) {
        const ref = dest[0];
        if (typeof ref === 'number') {
          pageIndex = ref;
        } else if (typeof ref === 'object' && ref !== null) {
          pageIndex = await doc.getPageIndex(ref);
        }
      }
    } catch {
      // Unresolvable destination, leave pageIndex undefined
    }
    const children = Array.isArray(item.items) && item.items.length > 0
      ? await resolvePdfOutline(doc, item.items)
      : [];
    result.push({
      title: String(item.title || '').trim() || 'Untitled Section',
      dest: item.dest,
      pageIndex,
      items: children,
    });
  }
  return result;
}

/**
 * Computes total number of outline nodes recursively.
 */
export function countOutlineNodes(nodes: readonly OutlineNode[]): number {
  let count = 0;
  for (const node of nodes) {
    count += 1 + countOutlineNodes(node.items);
  }
  return count;
}

/**
 * Formats a blockquote HTML snippet linking back to a specific PDF page.
 */
export function formatQuoteHtml(quoteText: string, pageIndex: number): string {
  const cleanQuote = quoteText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<blockquote><p>“${cleanQuote}” — <a href="#page=${pageIndex + 1}" data-page="${pageIndex + 1}">p. ${pageIndex + 1}</a></p></blockquote><p></p>`;
}
