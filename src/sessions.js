/**
 * In-memory session store for Fluduro.
 * Stores quiz progress, answers, and metadata keyed by mcp-session-id.
 * Sessions expire after SESSION_TTL_MS of inactivity and are purged periodically.
 */
const sessions = new Map();

const SESSION_TTL_MS = 30 * 60 * 1000;  // 30 minutes of inactivity
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // purge every 15 minutes

// Auto-cleanup stale sessions on a recurring timer
const _cleanupTimer = setInterval(() => {
  cleanupSessions();
}, CLEANUP_INTERVAL_MS);

// Allow Node.js to exit even if this timer is active
_cleanupTimer.unref?.();

/**
 * Get or initialize a session by ID.
 * @param {string} sessionId
 * @returns {Object|null} The session object, or null if sessionId is falsy
 */
export function getSession(sessionId) {
  if (!sessionId) return null;

  if (!sessions.has(sessionId)) {
    console.log(`[${new Date().toISOString()}] [Sessions] Creating NEW session: ${sessionId}`);
    sessions.set(sessionId, {
      id: sessionId,
      answers: {},
      questions: [],
      progress: 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  const session = sessions.get(sessionId);
  session.updatedAt = new Date().toISOString();
  return session;
}

/**
 * Update session data by merging provided fields.
 * @param {string} sessionId
 * @param {Object} data - Data to merge into the session
 * @returns {Object|null}
 */
export function updateSession(sessionId, data) {
  const session = getSession(sessionId);
  if (session) {
    Object.assign(session, data);
    session.updatedAt = new Date().toISOString();
  }
  return session;
}

/**
 * Remove a specific session.
 * @param {string} sessionId
 * @returns {boolean}
 */
export function clearSession(sessionId) {
  return sessions.delete(sessionId);
}

/**
 * Purge sessions that have been inactive longer than SESSION_TTL_MS.
 */
export function cleanupSessions() {
  const now = Date.now();
  let removed = 0;
  for (const [id, session] of sessions.entries()) {
    const lastActive = new Date(session.updatedAt).getTime();
    if (now - lastActive > SESSION_TTL_MS) {
      sessions.delete(id);
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`[${new Date().toISOString()}] [Sessions] Cleaned up ${removed} expired session(s). Active: ${sessions.size}`);
  }
}

/**
 * Returns the number of currently active sessions (for monitoring).
 * @returns {number}
 */
export function getSessionCount() {
  return sessions.size;
}
