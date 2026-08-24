'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

class ZoteroDatabase {
  constructor({
    databasePath = process.env.ZOTERO_DATABASE || path.join(process.env.USERPROFILE || '', 'Zotero', 'zotero.sqlite'),
    storagePath = process.env.ZOTERO_STORAGE || path.join(process.env.USERPROFILE || '', 'Zotero', 'storage')
  } = {}) {
    this.databasePath = databasePath;
    this.storagePath = storagePath;
    if (!fs.existsSync(databasePath)) {
      throw new Error(
        `Zotero database not found at ${databasePath}.\n` +
        'Set ZOTERO_DATABASE to the path of zotero.sqlite and ZOTERO_STORAGE to its storage folder.\n' +
        'Close desktop Zotero first if the file is locked.'
      );
    }
    this.database = new DatabaseSync(databasePath, { readOnly: true });
    // Desktop Zotero holds write locks during sync; wait instead of failing with SQLITE_BUSY.
    this.database.exec('PRAGMA busy_timeout = 5000');
    this.itemCache = [];
  }

  async refreshItems() {
    const rows = this.database.prepare(`
      SELECT i.itemID, i.key, i.dateAdded, i.dateModified,
             t.typeName,
             (SELECT COUNT(*) FROM itemNotes n
              JOIN items ni ON ni.itemID = n.itemID
              LEFT JOIN deletedItems nd ON nd.itemID = ni.itemID
              WHERE n.parentItemID = i.itemID AND nd.itemID IS NULL) AS noteCount,
             (SELECT value FROM itemData d
              JOIN itemDataValues v ON v.valueID = d.valueID
              JOIN fieldsCombined f ON f.fieldID = d.fieldID
              WHERE d.itemID = i.itemID AND f.fieldName = 'title') AS title
      FROM items i
      JOIN itemTypes t ON t.itemTypeID = i.itemTypeID
      LEFT JOIN deletedItems deleted ON deleted.itemID = i.itemID
      WHERE t.typeName NOT IN ('attachment', 'note', 'annotation')
        AND deleted.itemID IS NULL
        AND EXISTS (
          SELECT 1 FROM itemData d
          JOIN fieldsCombined f ON f.fieldID = d.fieldID
          WHERE d.itemID = i.itemID AND f.fieldName = 'title'
        )
      ORDER BY datetime(i.dateModified) DESC
    `).all();

    const creatorRows = this.database.prepare(`
      SELECT ic.itemID, TRIM(c.firstName || ' ' || c.lastName) AS name
      FROM itemCreators ic
      JOIN creators c ON c.creatorID = ic.creatorID
      ORDER BY ic.orderIndex
    `).all();
    const attachmentRows = this.database.prepare(`
      SELECT parentItemID, COUNT(*) AS count
      FROM itemAttachments a
      JOIN items i ON i.itemID = a.itemID
      LEFT JOIN deletedItems d ON d.itemID = i.itemID
      WHERE a.contentType = 'application/pdf' AND d.itemID IS NULL
      GROUP BY parentItemID
    `).all();

    const creators = new Map();
    for (const row of creatorRows) {
      if (!creators.has(row.itemID)) creators.set(row.itemID, []);
      creators.get(row.itemID).push(row.name);
    }
    const attachments = new Map(attachmentRows.map(row => [row.parentItemID, row.count]));
    this.itemCache = rows.map(row => ({
      id: row.itemID,
      key: row.key,
      title: row.title || 'Untitled',
      itemType: row.typeName,
      creators: creators.get(row.itemID) || [],
      pdfCount: attachments.get(row.itemID) || 0,
      noteCount: row.noteCount || 0,
      dateAdded: row.dateAdded,
      dateModified: row.dateModified
    }));
    return this.itemCache;
  }

  get items() {
    return this.itemCache;
  }

  getItemByKey(key) {
    return this.items.find(item => item.key === key);
  }

  /** One query for all item ids in a collection — avoids per-item lookups when filtering lists. */
  collectionItemIds(collectionId) {
    const rows = this.database.prepare(`
      SELECT ci.itemID
      FROM collectionItems ci
      JOIN items i ON i.itemID = ci.itemID
      LEFT JOIN deletedItems d ON d.itemID = i.itemID
      WHERE ci.collectionID = ? AND d.itemID IS NULL
    `).all(Number(collectionId));
    return new Set(rows.map(row => row.itemID));
  }

  /** Same idea for tag filtering: one query, Set of itemIDs. */
  tagItemIds(tagName) {
    const rows = this.database.prepare(`
      SELECT it.itemID
      FROM itemTags it
      JOIN tags t ON t.tagID = it.tagID
      JOIN items i ON i.itemID = it.itemID
      LEFT JOIN deletedItems d ON d.itemID = i.itemID
      WHERE t.name = ? COLLATE NOCASE AND d.itemID IS NULL
    `).all(String(tagName));
    return new Set(rows.map(row => row.itemID));
  }

  /** Distinct tags with usage counts, for the browse-by-tag UI. */
  listTags() {
    return this.database.prepare(`
      SELECT t.name AS name, COUNT(DISTINCT it.itemID) AS count
      FROM tags t
      JOIN itemTags it ON it.tagID = t.tagID
      JOIN items i ON i.itemID = it.itemID
      LEFT JOIN deletedItems d ON d.itemID = i.itemID
      WHERE d.itemID IS NULL
      GROUP BY t.name
      ORDER BY count DESC, t.name COLLATE NOCASE
    `).all();
  }

  itemDetail(key) {
    const summary = this.getItemByKey(key);
    if (!summary) return null;
    const fields = Object.fromEntries(this.database.prepare(`
      SELECT f.fieldName, v.value
      FROM itemData d
      JOIN fieldsCombined f ON f.fieldID = d.fieldID
      JOIN itemDataValues v ON v.valueID = d.valueID
      WHERE d.itemID = ?
    `).all(summary.id).map(row => [row.fieldName, row.value]));
    const creators = this.database.prepare(`
      SELECT c.firstName, c.lastName, ct.creatorType
      FROM itemCreators ic
      JOIN creators c ON c.creatorID = ic.creatorID
      JOIN creatorTypes ct ON ct.creatorTypeID = ic.creatorTypeID
      WHERE ic.itemID = ?
      ORDER BY ic.orderIndex
    `).all(summary.id);
    const tags = this.database.prepare(`
      SELECT tag.name FROM itemTags it JOIN tags tag ON tag.tagID = it.tagID
      WHERE it.itemID = ? ORDER BY tag.name
    `).all(summary.id).map(row => row.name);
    const collections = this.database.prepare(`
      SELECT c.collectionID AS id, c.collectionName AS name
      FROM collectionItems ci JOIN collections c ON c.collectionID = ci.collectionID
      WHERE ci.itemID = ? ORDER BY c.collectionName
    `).all(summary.id);
    const notes = this.database.prepare(`
      SELECT n.itemID, n.note, n.title, i.dateModified
      FROM itemNotes n JOIN items i ON i.itemID = n.itemID
      WHERE n.parentItemID = ?
      ORDER BY datetime(i.dateModified) DESC
    `).all(summary.id);
    const attachments = this.attachmentsFor(summary.id);
    const annotations = this.database.prepare(`
      SELECT type, text, comment, color, pageLabel, authorName
      FROM itemAnnotations WHERE parentItemID = ? ORDER BY sortIndex
    `).all(summary.id);
    return { ...summary, fields, creators, tags, collections, notes, annotations, attachments };
  }

  attachmentsFor(itemId) {
    return this.database.prepare(`
      SELECT a.itemID, i.key, a.path, a.contentType
      FROM itemAttachments a JOIN items i ON i.itemID = a.itemID
      LEFT JOIN deletedItems d ON d.itemID = i.itemID
      WHERE a.parentItemID = ? AND a.contentType = 'application/pdf'
        AND a.path LIKE 'storage:%' AND d.itemID IS NULL
      ORDER BY i.dateAdded
    `).all(itemId).map(row => {
      const fileName = path.basename(String(row.path).replace(/^storage:/, ''));
      const directory = path.join(this.storagePath, row.key);
      return {
        id: row.itemID,
        key: row.key,
        fileName,
        contentType: row.contentType,
        exists: this.safeExists(path.join(directory, fileName))
      };
    });
  }

  safeExists(filePath) {
    try {
      return fs.existsSync(filePath);
    } catch {
      return false;
    }
  }

  resolvePdf(itemKey, attachmentKey) {
    const summary = this.getItemByKey(itemKey);
    if (!summary) return null;
    let attachments = this.attachmentsFor(summary.id);
    if (attachmentKey) attachments = attachments.filter(file => file.key === attachmentKey);
    const target = attachments.find(file => file.exists);
    if (!target) return null;
    const resolved = path.resolve(this.storagePath, target.key, target.fileName);
    const allowedRoot = path.resolve(this.storagePath, target.key);
    if (!resolved.startsWith(allowedRoot + path.sep)) return null;
    return { ...target, itemKey, filePath: resolved, textCachePath: path.join(allowedRoot, '.zotero-ft-cache') };
  }

  close() {
    this.database.close();
  }
}

module.exports = { ZoteroDatabase };
