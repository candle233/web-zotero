'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

class OfflineLibrary {
  constructor(dataDir) {
    this.root = path.join(dataDir, 'offline');
  }

  async save(itemKey, attachmentKey, sourcePath) {
    const safeItemKey = path.basename(String(itemKey || ''));
    if (!safeItemKey || safeItemKey === '.' || safeItemKey === '..') throw new Error('Invalid item key.');
    const target = path.join(this.root, safeItemKey);
    await fsp.mkdir(target, { recursive: true });
    const fileName = path.basename(sourcePath);
    const destination = path.join(target, `${attachmentKey}-${fileName}`);
    if (path.resolve(sourcePath) !== path.resolve(destination)) {
      await fsp.copyFile(path.resolve(sourcePath), path.resolve(destination), 0);
    }
    const stat = await fsp.stat(destination);
    return { itemKey: safeItemKey, attachmentKey, filePath: destination, size: stat.size };
  }

  async list() {
    return this.listDetailed();
  }

  /** Removes one stored copy (or the whole item folder when no attachment given). */
  async remove(itemKey, attachmentKey = null) {
    const safeItemKey = path.basename(String(itemKey || ''));
    if (!safeItemKey || safeItemKey === '.' || safeItemKey === '..') throw new Error('Invalid item key.');
    const folder = path.join(this.root, safeItemKey);
    if (!attachmentKey) {
      await fsp.rm(folder, { recursive: true, force: true });
      return { ok: true, removed: safeItemKey };
    }
    const prefix = `${String(attachmentKey)}-`;
    let removed = 0;
    let entries = [];
    try {
      entries = await fsp.readdir(folder);
    } catch {
      return { ok: true, removed: 0 };
    }
    for (const name of entries) {
      if (!name.startsWith(prefix)) continue;
      await fsp.rm(path.join(folder, name), { force: true });
      removed += 1;
    }
    // Drop the folder once it holds nothing.
    try {
      if ((await fsp.readdir(folder)).length === 0) await fsp.rmdir(folder);
    } catch {
      // Racy removal is fine — the goal is only best-effort cleanup.
    }
    return { ok: true, removed };
  }

  async listDetailed() {
    try {
      const entries = await fsp.readdir(this.root, { withFileTypes: true });
      return entries.filter(entry => entry.isDirectory()).map(entry => ({ itemKey: entry.name }));
    } catch {
      return [];
    }
  }
}

module.exports = { OfflineLibrary };
