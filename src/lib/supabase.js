import { createClient } from "@supabase/supabase-js";

// Supabase configuration
const supabaseUrl =
  import.meta.env.VITE_SUPABASE_URL || "https://your-project.supabase.co";
const supabaseAnonKey =
  import.meta.env.VITE_SUPABASE_ANON_KEY || "your-anon-key";

// ==========================================
// SINGLETON PATTERN - ensure only one client
// ==========================================
let supabaseInstance = null;
let supabasePublicInstance = null;

function getSupabaseClient() {
  if (!supabaseInstance) {
    
    supabaseInstance = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storage: window.localStorage,
        storageKey: "supabase.auth.token",
        // Disable navigator.locks to avoid AbortError when multiple tabs are open.
        lock: false,
      },
      global: {
        headers: {
          "X-Client-Info": "supabase-js-web",
        },
      },
    });
  }
  return supabaseInstance;
}

function getSupabasePublicClient() {
  if (!supabasePublicInstance) {
    
    supabasePublicInstance = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }
  return supabasePublicInstance;
}

// Export singleton clients
export const supabase = getSupabaseClient();
export const supabasePublic = getSupabasePublicClient();

// Export auth for convenience
export const auth = supabase.auth;

// ==========================================
// AUTH TIMEOUT CONSTANTS  (✅ FIXED)
// ==========================================
// 30 minutes is WAY too long for UI requests.
// Keep these short so tab-switch doesn't “hang” for ages.
export const AUTH_TIMEOUT_MS = 10_000; // 10s for auth operations
export const SESSION_CHECK_TIMEOUT_MS = 8_000; // 8s for session checks

// ==========================================
// TIMEOUT WRAPPER FOR PROMISES
// ==========================================
export class AuthTimeoutError extends Error {
  constructor(operation, timeoutMs) {
    super(`Auth operation '${operation}' timed out after ${timeoutMs}ms`);
    this.name = "AuthTimeoutError";
  }
}

/**
 * Wraps a promise with a timeout. If the timeout is reached, the promise rejects.
 */
export async function withTimeout(promise, timeoutMs, operationName) {
  let timeoutId;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new AuthTimeoutError(operationName, timeoutMs));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutId);
    return result;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

// ==========================================
// SESSION MANAGEMENT WITH TIMEOUTS
// ==========================================

/**
 * Gets the current session with a timeout.
 * If timeout occurs, returns null and logs warning.
 */
export async function getSessionWithTimeout(timeoutMs = AUTH_TIMEOUT_MS) {
  // ✅ 1) Local fast path: read from storage first
  try {
    const raw = localStorage.getItem("supabase.auth.token");
    if (raw) {
      const parsed = JSON.parse(raw);
      // supabase-js stores shape like: { currentSession: {...} } OR { access_token: ... }
      const localSession = parsed?.currentSession || parsed;
      if (localSession?.access_token) {
        // If it has expiry and still valid, return it immediately
        if (localSession.expires_at) {
          const now = Math.floor(Date.now() / 1000);
          if (localSession.expires_at - now > 30) {
            // ✅ valid for at least 30s
            return localSession;
          }
        } else {
          // No expiry info, still allow it
          return localSession;
        }
      }
    }
  } catch (e) {
    // ignore storage parse errors
  }

  // ✅ 2) Fallback: supabase auth.getSession (can be slow in background tabs)
  
  try {
    const result = await withTimeout(
      auth.getSession(),
      timeoutMs,
      "getSession",
    );
    
    return result.data.session;
  } catch (error) {
    if (error instanceof AuthTimeoutError) {
      console.error("[getSessionWithTimeout] TIMEOUT - session fetch hung");
      return null;
    }
    console.error("[getSessionWithTimeout] Error:", error);
    return null;
  }
}

/**
 * Gets the current user with a timeout.
 * If timeout occurs, returns null.
 */
export async function getUserWithTimeout(timeoutMs = AUTH_TIMEOUT_MS) {
  
  try {
    const result = await withTimeout(auth.getUser(), timeoutMs, "getUser");
    
    return result.data.user;
  } catch (error) {
    if (error instanceof AuthTimeoutError) {
      console.error("[getUserWithTimeout] TIMEOUT - user fetch hung");
      return null;
    }
    console.error("[getUserWithTimeout] Error:", error);
    return null; // ✅ do not throw here
  }
}

/**
 * Attempts to refresh the session silently.
 * Uses auth.getSession() first (triggers auto-refresh via stored refresh token),
 * then falls back to explicit auth.refreshSession() if needed.
 * Returns true if session was refreshed successfully, false otherwise.
 */
export async function refreshSessionSilently(timeoutMs = AUTH_TIMEOUT_MS) {
  
  try {
    // Try getSession first — it reads from storage and auto-refreshes
    // if the access token is expired but refresh token is valid.
    // This is typically faster and more reliable than auth.refreshSession().
    const getSessionResult = await withTimeout(
      auth.getSession(),
      Math.min(timeoutMs, 8000),
      "getSession-refresh",
    );

    if (getSessionResult?.data?.session?.access_token) {
      
      return true;
    }
  } catch (e) {
    // getSession failed/timed out — fall through to explicit refresh
    console.debug("[refreshSessionSilently] getSession failed, trying explicit refresh:", e?.message || e);
  }

  try {
    const { data, error } = await withTimeout(
      auth.refreshSession(),
      timeoutMs,
      "refreshSession",
    );

    if (error) {
      console.warn("[refreshSessionSilently] Refresh failed:", error);
      return false;
    }

    if (data.session) {
      
      return true;
    }

    
    return false;
  } catch (e) {
    if (e instanceof AuthTimeoutError) {
      console.warn("[refreshSessionSilently] TIMEOUT during refresh");
      return false;
    }
    console.warn("[refreshSessionSilently] Error during refresh:", e);
    return false;
  }
}

/**
 * Clears stale session data from localStorage.
 * Use this when the session is definitely invalid.
 */
export function clearStaleSession() {
  
  try {
    localStorage.removeItem("shopify-report-auth");
  } catch (e) {
    console.warn("[clearStaleSession] Could not clear localStorage:", e);
  }
}

// ==========================================
// ✅ FAST ensureValidSession (TTL + in-flight dedupe)
// ==========================================
// Prevents double session checks when queryProductsPage + queryProductStats run together.
let lastSessionCheckAt = 0;
let inFlightSessionPromise = null;

const SESSION_CHECK_TTL_MS = 30_000; // 30s: skip repeated session checks

/**
 * Ensures the Supabase session is valid before making authenticated requests.
 * - TTL: only checks at most once per SESSION_CHECK_TTL_MS
 * - Dedupes concurrent calls: shares one in-flight promise
 * - Only refreshes when near expiry or missing
 */
export async function ensureValidSession(
  timeoutMs = SESSION_CHECK_TIMEOUT_MS,
  force = false,
) {
  const now = Date.now();

  // ✅ Skip frequent checks
  if (!force && now - lastSessionCheckAt < SESSION_CHECK_TTL_MS) {
    return null; // caller doesn't need session object; just ensure auth is okay
  }

  // ✅ Deduplicate concurrent checks
  if (inFlightSessionPromise) {
    return inFlightSessionPromise;
  }

  inFlightSessionPromise = (async () => {
    
    try {
      let session = await getSessionWithTimeout(timeoutMs);

      // If missing session, try a single refresh (fast)
      if (!session) {
        console.warn(
          "[ensureValidSession] No session from initial check. Attempting silent refresh...",
        );
        const refreshed = await refreshSessionSilently(15_000);

        if (refreshed) {
          session = await getSessionWithTimeout(AUTH_TIMEOUT_MS);
        } else {
          // ✅ IMPORTANT: if refresh failed/timed out, DO NOT hard-fail.
          // Let queries proceed — client may still have a valid token.
          console.warn(
            "[ensureValidSession] Refresh failed/timed out, proceeding without blocking.",
          );
          lastSessionCheckAt = Date.now(); // avoid spamming refresh
          return null;
        }
      }

      // If we still don't have a session, stop here
      if (!session) {
        console.warn("[ensureValidSession] No valid session available");
        return null;
      }

      // Proactive refresh if expiring soon (only once)
      const expiresAt = session.expires_at;
      if (expiresAt) {
        const nowSec = Math.floor(Date.now() / 1000);
        const timeUntilExpiry = expiresAt - nowSec;
        if (timeUntilExpiry < 60) {
          
          const ok = await refreshSessionSilently(
            Math.min(timeoutMs, AUTH_TIMEOUT_MS),
          );
          if (ok) {
            session = await getSessionWithTimeout(
              Math.min(timeoutMs, AUTH_TIMEOUT_MS),
            );
          }
        }
      }

      lastSessionCheckAt = Date.now();
      
      return session;
    } catch (e) {
      console.error("[ensureValidSession] Unexpected error:", e);
      return null;
    } finally {
      inFlightSessionPromise = null;
    }
  })();

  return inFlightSessionPromise;
}

// ==========================================
// ABORT ERROR DETECTION
// ==========================================
export function isAbortError(error) {
  if (!error) return false;
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  const msg = error?.message || String(error);
  return (
    error?.name === 'AbortError' ||
    msg.includes('AbortError') ||
    msg.includes('signal is aborted')
  );
}

// ==========================================
// INITIALIZATION HELPER WITH TIMEOUT
// ==========================================
export async function initializeAuthWithTimeout(timeoutMs = AUTH_TIMEOUT_MS) {
  
  const MAX_RETRIES = 2;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let session = null;
    let timedOut = false;
    try {
      session = await withTimeout(
        (async () => {
          
          const { data, error } = await auth.getSession();
          if (error) {
            console.warn("[initializeAuthWithTimeout] Session error:", error);
            throw error;
          }
          
          return data.session;
        })(),
        timeoutMs,
        "initializeAuth",
      );
      
      return { session, timedOut: false };
    } catch (error) {
      if (error instanceof AuthTimeoutError) {
        timedOut = true;
        console.error(
          "[initializeAuthWithTimeout] TIMEOUT - auth initialization hung",
        );
        return { session, timedOut, error };
      }

      // Supabase JS v2 can throw AbortError due to internal navigator.locks
      // race conditions. Retry once after a short delay.
      if (isAbortError(error) && attempt < MAX_RETRIES) {
        console.debug(
          `[initializeAuthWithTimeout] AbortError on attempt ${attempt}, retrying in 500ms...`,
        );
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }

      if (isAbortError(error)) {
        return { session, timedOut, error };
      }
      console.error("[initializeAuthWithTimeout] Error:", error);
      return { session, timedOut, error };
    }
  }

  // Should never reach here, but just in case
  return { session: null, timedOut: false, error: new Error('Max retries exceeded') };
}

// ==========================================
// SESSION KEEP-ALIVE (proactive token refresh)
// ==========================================
let keepAliveTimer = null;
const KEEP_ALIVE_INTERVAL_MS = 4 * 60 * 1000; // 4 minutes

/**
 * Starts a periodic check that refreshes the session token before it expires.
 * Also refreshes when the tab returns from background.
 * Call once at app startup.
 */
export function startSessionKeepAlive() {
  if (keepAliveTimer) return; // already running

  const doKeepAlive = async () => {
    try {
      const session = await getSessionWithTimeout(5000);
      if (!session) return; // not logged in

      const expiresAt = session.expires_at;
      if (expiresAt) {
        const nowSec = Math.floor(Date.now() / 1000);
        const secsLeft = expiresAt - nowSec;
        // Refresh if expiring within 5 minutes
        if (secsLeft < 300) {
          console.debug('[keepAlive] Token expiring soon, refreshing...');
          await refreshSessionSilently(10_000);
        }
      }
    } catch (e) {
      console.debug('[keepAlive] Error (non-fatal):', e?.message || e);
    }
  };

  // Run immediately, then on interval
  doKeepAlive();
  keepAliveTimer = setInterval(doKeepAlive, KEEP_ALIVE_INTERVAL_MS);

  // Also refresh on tab return from background
  const onVisible = () => {
    if (document.visibilityState === 'visible') {
      doKeepAlive();
    }
  };
  document.addEventListener('visibilitychange', onVisible);
}

// ==========================================
// SUPABASE CALL WRAPPER WITH LOGGING
// ==========================================
export async function loggedSupabaseCall(operationName, queryFn, timeoutMs) {
  
  const startTime = Date.now();

  try {
    let result;
    if (timeoutMs) {
      result = await withTimeout(queryFn(), timeoutMs, operationName);
    } else {
      result = await queryFn();
    }

    const duration = Date.now() - startTime;
    
    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    if (error instanceof AuthTimeoutError) {
      console.error(`[Supabase:${operationName}] TIMEOUT after ${duration}ms`);
    } else {
      console.error(
        `[Supabase:${operationName}] ERROR after ${duration}ms:`,
        error,
      );
    }
    throw error;
  }
}
