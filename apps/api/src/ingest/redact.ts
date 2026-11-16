/**
 * Masks things that look like credentials before any prompt or command text is
 * stored. It is a safety net, not a guarantee: the hub should still sit on a
 * private network.
 */
const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b[A-Fa-f0-9]{32,}\b/g,
  /\b[A-Za-z0-9+/_-]{40,}={0,2}/g,
];

export const REDACTED = '[redacted]';

export function redactSecrets(text: string): string {
  let out = text;
  // key=value, key: value, --token value, "password": "value"
  out = out.replace(
    /(\b(?:pass(?:word|wd)?|token|secret|api[_-]?key|auth(?:orization)?|bearer|credential)s?\b["']?\s*[:=]\s*(?:(?:Bearer|Basic)\s+)?)(?:"[^"\n]*"|'[^'\n]*'|[^\s"',;&]+)/gi,
    `$1${REDACTED}`,
  );
  out = out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${REDACTED}`);
  out = out.replace(/(--(?:password|token|secret|api-key)(?:=|\s+))\S+/gi, `$1${REDACTED}`);
  out = out.replace(/(:\/\/[^\s:/@]+:)[^\s@/]+(@)/g, `$1${REDACTED}$2`);
  for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

/**
 * Cleans free text for storage: control characters (other than newline and tab)
 * become spaces, secrets are masked, and the result is cut to `max` characters.
 * Returns undefined when nothing is left.
 */
export function cleanText(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  const flat = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ')
    .trim();
  if (!flat) return undefined;
  const masked = redactSecrets(flat);
  const cut = masked.length > max ? `${masked.slice(0, max - 1).trimEnd()}…` : masked;
  return cut || undefined;
}
