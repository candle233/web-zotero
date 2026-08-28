'use strict';

const { isPostgresReachable } = require('./detect-postgres');

class HealthMonitor {
  constructor({
    zoteroDatabase,
    searchIndex,
    webStore = null,
    userStore = null,
    annotationStore = null,
    s3Storage = null,
    aiBaseUrl = null,
    openAiApiKey = '',
    formulaOcrUrl = null
  } = {}) {
    this.zoteroDatabase = zoteroDatabase;
    this.searchIndex = searchIndex;
    this.s3Storage = s3Storage;
    this.aiBaseUrl = aiBaseUrl;
    this.openAiApiKey = openAiApiKey;
    this.formulaOcrUrl = formulaOcrUrl;
    // Stores are bound late (see _bindStores) so the PG path can be decided
    // after the constructor and the try/catch around store instantiation.
    this._webStore = null;
    this._userStore = null;
    this._annotationStore = null;
    this._pgUrl = null;
    this.startedAt = new Date().toISOString();
    this.errors = [];
  }

  /** Bind stores after store construction (called from server.js after the PG/SQLite split). */
  _bindStores(webStore, userStore, annotationStore) {
    this._webStore = webStore;
    this._userStore = userStore;
    this._annotationStore = annotationStore;
  }

  recordError(scope, error) {
    this.errors.unshift({ scope, message: error?.message || String(error), at: new Date().toISOString() });
    this.errors = this.errors.slice(0, 20);
  }

  /** Cheap liveness probe for one SQLite or PostgreSQL-backed store. */
  async _probeStore(store) {
    if (!store) return null; // not provided / not yet bound
    // Return null for stores that have not been configured (no recognised backend).
    if (!store.database && !store.pool) return null;
    try {
      if (store.database) store.database.prepare('SELECT 1').get();       // node:sqlite
      else if (store.pool) await store.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  /** Probe PostgreSQL via detect-postgres (short timeout, cached by OS-level retry). */
  async _probePostgres() {
    if (!this._pgUrl) return false;
    return await isPostgresReachable(this._pgUrl, 1500);
  }

  /** Probe Pix2Text OCR endpoint (POST /pix2text with empty body, short timeout). */
  async _probeOcr() {
    if (!this.formulaOcrUrl) return false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${this.formulaOcrUrl}`, {
        method: 'POST',
        signal: controller.signal
      });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }

  async status({ eventBus = null } = {}) {
    const [zoteroOk, webOk, usersOk, annotationsOk, pgOk, ocrOk] = await Promise.all([
      this._probeStore(this.zoteroDatabase),
      this._probeStore(this._webStore),
      this._probeStore(this._userStore),
      this._probeStore(this._annotationStore),
      this._probePostgres(),
      this._probeOcr()
    ]);

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
      services: {
        postgres: pgOk,
        ocr: ocrOk,
        ai: {
          provider: this.openAiApiKey ? 'openai' : this.aiBaseUrl?.includes('127.0.0.1') || this.aiBaseUrl?.includes('localhost') ? 'openai-compatible' : 'local'
        },
        s3: this.s3Storage ? this.s3Storage.isConfigured() : false
      },
      sseSubscribers: eventBus ? eventBus.subscriberCount : undefined,
      recentErrors: this.errors
    };
  }
}

module.exports = { HealthMonitor };
