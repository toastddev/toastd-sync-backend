import { Collections, SETTINGS_DOC } from "../firestore.js";
import { log } from "../lib/log.js";
import type { Settings } from "../types.js";
import { refreshShipTurtleToken, ShipTurtleAuthError } from "./shipturtle.js";

export interface RefreshOutcome {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

/**
 * Refresh the ShipTurtle bearer using the credentials stored on `settings` and
 * persist the new token (and refresh_token) to Firestore. Returns the new token
 * payload. Throws if auto-refresh is disabled or credentials are incomplete.
 */
export async function refreshAndPersistShipTurtleToken(settings: Settings): Promise<RefreshOutcome> {
  if (!settings.shipturtleAutoRefreshEnabled) {
    throw new Error("ShipTurtle auto-refresh is disabled in Settings");
  }
  const tok = await refreshShipTurtleToken({
    username: settings.shipturtleUsername,
    password: settings.shipturtlePassword,
    clientId: settings.shipturtleClientId,
    clientSecret: settings.shipturtleClientSecret,
    refreshToken: settings.shipturtleRefreshToken,
  });
  const now = Date.now();
  const patch: Partial<Settings> = {
    shipturtleToken: tok.access_token,
    shipturtleRefreshToken: tok.refresh_token,
    shipturtleTokenExpiresAt: now + tok.expires_in * 1000,
    shipturtleTokenRefreshedAt: now,
    updatedAt: now,
  };
  await Collections.settings.doc(SETTINGS_DOC).set(patch, { merge: true });
  Object.assign(settings, patch);
  return { access_token: tok.access_token, refresh_token: tok.refresh_token, expires_in: tok.expires_in };
}

/**
 * Run `op()` and, if it throws a `ShipTurtleAuthError`, refresh the stored
 * ShipTurtle bearer via the saved OAuth credentials (refresh_token first,
 * falling back to password grant) and retry the operation exactly once.
 *
 * Used at the route + scheduler entry points: the underlying pipeline reads
 * `getSettings()` on every call, so after we persist the new bearer the retry
 * naturally picks it up without any plumbing.
 */
export async function withShipTurtleAuthRetry<T>(
  loadSettings: () => Promise<Settings>,
  op: () => Promise<T>,
): Promise<T> {
  try {
    return await op();
  } catch (e) {
    if (!(e instanceof ShipTurtleAuthError)) throw e;
    const settings = await loadSettings();
    if (!settings.shipturtleAutoRefreshEnabled) throw e;
    await log({
      level: "warn",
      message: "ShipTurtle auth expired — attempting automatic refresh",
      step: "system",
    });
    try {
      await refreshAndPersistShipTurtleToken(settings);
    } catch (refreshErr: any) {
      await log({
        level: "error",
        message: `ShipTurtle auto-refresh failed: ${refreshErr.message}`,
        step: "system",
      });
      throw e;
    }
    await log({
      level: "success",
      message: "ShipTurtle token refreshed — retrying original request",
      step: "system",
    });
    return op();
  }
}
