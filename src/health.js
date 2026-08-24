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

  /** Cheap liveness probe for one SQLite-backed store. */
  probe(prepare) {
    if (typeof prepare !== 'function') return null; // not provided
    try { prepare(); return true; } catch { return false; }
  }

  status({ eventBus = null } = {}) {
    const zoteroOk = this.probe(() => this.zoteroDatabase.database.prepare('SELECT 1').get());
    const webOk = this.probe(() => this.webStore.database.prepare('SELECT 1').get());
    const usersOk = this.probe(() => this.userStore?.database.prepare('SELECT 1').get());
    const annotationsOk = this.probe(() => this.annotationStore?.database.prepare('SELECT 1').get());
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
