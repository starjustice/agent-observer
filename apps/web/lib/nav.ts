/**
 * Full page load on purpose. Signing in or out changes the cookie the proxy
 * checks, so the next page must come from the server, not the client cache.
 */
export function hardNavigate(path: "/" | "/login"): void {
  window.location.assign(path);
}
