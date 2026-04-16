/**
 * Token bridge: lets the API client (a non-React module) request the current
 * Clerk JWT without importing any React hooks.
 *
 * Usage:
 *  - Call `setTokenGetter(getToken)` once at the root of the React tree (after
 *    ClerkProvider mounts), passing Clerk's `getToken` from `useAuth()`.
 *  - The API client calls `getAuthToken()` when building requests.
 */

let tokenGetter: (() => Promise<string | null>) | null = null;

export function setTokenGetter(fn: () => Promise<string | null>) {
  tokenGetter = fn;
}

export async function getAuthToken(): Promise<string | null> {
  if (!tokenGetter) return null;
  return tokenGetter();
}
