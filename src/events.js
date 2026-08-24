'use strict';

/**
 * In-process publish/subscribe bus backing the /api/events SSE stream (R9).
 *
 * Zero-dependency live sync: annotation mutations publish structured events;
 * every connected browser page (annotator tabs, library) receives them over a
 * long-lived text/event-stream response. The bus tracks connection teardown
 * callbacks so the HTTP server can shut down cleanly while streams are open.
 */

// Seeded from boot time so ids stay monotonic across server restarts; a
// reconnecting client's Last-Event-ID never collides with a fresh stream.
let nextEventId = Date.now();
const REPLAY_BUFFER_LIMIT = 200;

class EventBus {
  constructor() {
    this.subscribers = new Set(); // { send(event), close() }
    this.recent = [];             // ring buffer for Last-Event-ID replay
  }

  get subscriberCount() {
    return this.subscribers.size;
  }

  /**
   * Registers a subscriber. `send` receives {id, type, payload} and must
   * return false (or throw) when the underlying connection is gone.
   * `lastEventId`: replays buffered events newer than it before going live,
   * so a reconnecting EventSource misses nothing during the gap.
   * `close` option: called by closeAll() during server shutdown.
   */
  subscribe(send, { close = null, lastEventId = null } = {}) {
    const subscriber = { send, close };
    // Absent id = fresh connection (no history); an explicit number — even 0,
    // "seen nothing" — replays every buffered event newer than it.
    if (lastEventId != null) {
      for (const event of this.recent) {
        if (event.id <= lastEventId) continue;
        try {
          const alive = subscriber.send(event);
          if (alive === false) return () => {};
        } catch {
          return () => {};
        }
      }
    }
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  publish(type, payload) {
    const event = { id: nextEventId++, type, payload };
    this.recent.push(event);
    if (this.recent.length > REPLAY_BUFFER_LIMIT) this.recent.splice(0, this.recent.length - REPLAY_BUFFER_LIMIT);
    for (const subscriber of [...this.subscribers]) {
      try {
        const alive = subscriber.send(event);
        if (alive === false) this.subscribers.delete(subscriber);
      } catch {
        this.subscribers.delete(subscriber);
      }
    }
    return event.id;
  }

  /** Ends every tracked connection (invoked from the HTTP server shutdown path). */
  closeAll() {
    for (const subscriber of [...this.subscribers]) {
      this.subscribers.delete(subscriber);
      try {
        subscriber.close?.();
      } catch {
        // Connection already gone.
      }
    }
  }
}

module.exports = { EventBus };
