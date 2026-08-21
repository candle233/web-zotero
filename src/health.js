'use strict';

class HealthMonitor {
  constructor({ zoteroDatabase, searchIndex, webStore }) {
    this.zoteroDatabase = zoteroDatabase;
    this.searchIndex = searchIndex;
    this.webStore = webStore;
    this.startedAt = new Date().toISOString();
    this.errors = [];
  }

  recordError(scope, error) {
    this.errors.unshift({ scope, message: error?.message || String(error), at: new Date().toISOString() });
    this.errors = this.errors.slice(0, 20);
  }

  status() {
    let database = true;
    try { this.zoteroDatabase.database.prepare('SELECT 1').get(); } catch { database = false; }
    return {
      ok: database,
      startedAt: this.startedAt,
      uptimeSeconds: Math.round(process.uptime()),
      libraryItems: this.zoteroDatabase.items.length,
      index: this.searchIndex.status(),
      dependencies: { zoteroDatabase: database, webNotes: Boolean(this.webStore.database) },
      recentErrors: this.errors
    };
  }
}

module.exports = { HealthMonitor };
