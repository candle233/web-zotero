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
