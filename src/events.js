'use strict';

/**
 * In-process publish/subscribe bus backing the /api/events SSE stream (R9).
 *
 * Zero-dependency live sync: annotation mutations publish structured events;
 * every connected browser page (annotator tabs, library) receives them over a
 * long-lived text/event-stream response. The bus tracks connection teardown
 * callbacks so the HTTP server can shut down cleanly while streams are open.
 */

let nextEventId = 1;

class EventBus {
  constructor() {
    this.subscribers = new Set(); // { send(event), close() }
  }

  get subscriberCount() {
    return this.subscribers.size;
  }

  /**
   * Registers a subscriber. `send` receives {id, type, payload} and must
   * return false (or throw) when the underlying connection is gone.
   * `close` option: called by closeAll() during server shutdown.
   */
  subscribe(send, { close = null } = {}) {
    const subscriber = { send, close };
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  publish(type, payload) {
    const event = { id: nextEventId++, type, payload };
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
