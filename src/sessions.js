/**
 * In-memory session store for Plantora.
 * Stores quiz progress, answers, and metadata keyed by mcp-session-id.
 */
const sessions = new Map();

/**
 * Get or initialize a session by ID.
 * @param {string} sessionId 
 * @returns {Object} The session object
 */
export function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    console.log(`[Sessions] Creating NEW session object for: ${sessionId}`);
    sessions.set(sessionId, {
      id: sessionId,
      answers: {},
      questions: [],
      progress: 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  } else {
    console.log(`[Sessions] Retrieving EXISTING session: ${sessionId}`);
  }
  const session = sessions.get(sessionId);
  session.updatedAt = new Date().toISOString();
  return session;
}

/**
 * Update session data.
 * @param {string} sessionId 
 * @param {Object} data Data to merge into session
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
 * Remove a session.
 * @param {string} sessionId 
 */
export function clearSession(sessionId) {
  return sessions.delete(sessionId);
}

/**
 * Cleanup expired sessions (optional, e.g. sessions older than 1 hour)
 */
export function cleanupSessions() {
  const now = new Date();
  for (const [id, session] of sessions.entries()) {
    const updatedAt = new Date(session.updatedAt);
    if (now - updatedAt > 3600000) { // 1 hour
      sessions.delete(id);
    }
  }
}
