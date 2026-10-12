// Untrusted API fields, cleaned before they reach output. Providers pass
// id/title/url/repo/branch and timestamps raw; without this, terminal
// escape injection (ESC sequences, javascript: URLs) reaches both the
// JSON report and the human-readable text.
const ID = /^[A-Za-z0-9._-]{1,200}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?$/;
const URL = /^https?:\/\/[^\s]+$/i;
const MAX_TEXT = 500;
const MAX_URL = 2000;

// C0/C1 controls carry ESC sequences, and bidi/format characters reorder or
// hide text in terminals; drop them everywhere.
export function stripControls(value) {
  // eslint-disable-next-line no-control-regex, no-misleading-character-class
  return value.replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, '');
}

export function sanitizeText(value) {
  if (typeof value !== 'string') return null;
  const clean = stripControls(value).slice(0, MAX_TEXT);
  return clean.length > 0 ? clean : null;
}

export function sanitizeId(value) {
  if (typeof value !== 'string') return 'unknown';
  const clean = stripControls(value);
  return ID.test(clean) ? clean : 'unknown';
}

export function sanitizeUrl(value) {
  if (typeof value !== 'string') return null;
  const clean = stripControls(value);
  if (clean.length === 0 || clean.length > MAX_URL) return null;
  return URL.test(clean) ? clean : null;
}

// A repo is an http(s) URL (cursor) or an owner/repo name or id:N
// (copilot); anything with a scheme that is not http(s), such as
// javascript:, is dropped.
export function sanitizeRepo(value) {
  if (typeof value !== 'string') return null;
  const clean = stripControls(value).slice(0, MAX_TEXT);
  if (clean.length === 0) return null;
  if (/^id:\d{1,20}$/.test(clean)) return clean;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(clean)) return URL.test(clean) ? clean : null;
  return clean;
}

export function sanitizeTimestamp(value) {
  if (typeof value !== 'string') return null;
  if (value.length > 40 || stripControls(value) !== value) return null;
  return TIMESTAMP.test(value) ? value : null;
}
