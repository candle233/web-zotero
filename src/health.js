'use strict';

class HealthMonitor {
  constructor({ zoteroDatabase, searchIndex, webStore, userStore = null, annotationStore = null }) {
    this.zoteroDatabase = zoteroDatabase;
    this.searchIndex = searchIndex;
    this.webStore = webStore;
    this.userStore = userStore;
    this.annotationStore = annotationStore;
    this.startedAt = new Date().toISOString();
    this.errors = [];
  }

  recordError(scope, error) {
    this.errors.unshift({ scope, message: error?.message || String(error), at: new Date().toISOString() });
    this.errors = this.errors.slice(0, 20);
  }

  /** Cheap liveness probe for one SQLite or PostgreSQL-backed store. */
  async probe(store) {
    if (!store) return null; // not provided
    try {
      if (store.database) store.database.prepare('SELECT 1').get();       // node:sqlite
      else if (store.pool) await store.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async status({ eventBus = null } = {}) {
    const zoteroOk = await this.probe(this.zoteroDatabase);
    const webOk = await this.probe(this.webStore);
    const usersOk = await this.probe(this.userStore);
    const annotationsOk = await this.probe(this.annotationStore);
    return {
      ok: zoteroOk && webOk && usersOk !== false && annotationsOk !== false,
      startedAt: this.startedAt,
      uptimeSeconds: Math.round(process.uptime()),
      libraryItems: this.zoteroDatabase.items.length,
      index: this.searchIndex.status(),
      dependencies: {
        zoteroDatabase: zoteroOk,
        webNotes: webOk,
        users: usersOk,
        annotations: annotationsOk
      },
      sseSubscribers: eventBus ? eventBus.subscriberCount : undefined,
      recentErrors: this.errors
    };
  }
}

module.exports = { HealthMonitor };
