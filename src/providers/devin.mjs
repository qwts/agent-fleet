// Devin sessions, read from the Devin REST API: https://docs.devin.ai
// A poller on the control Mac (ADR-0001 §6). It only sends GET requests,
// with an API key that has read-only session visibility.
//
// One config host becomes one account record plus one record per session, all
// in the same report shape as an SSH host; a session's details go in `workload`.
import { sanitizeId, sanitizeText, sanitizeUrl } from '../sanitize.mjs';
import { TokenUnavailable, redact } from '../token.mjs';

export const kind = 'api';

export const DEFAULTS = Object.freeze({
  apiBase: 'https://api.devin.ai',
  orgId: '',
  keychainService: 'agent-fleet.devin',
  keychainAccount: 'agent-fleet',
  maxAgents: 100,
});

export const expects = Object.freeze([]);

const STATES = new Set(['new', 'claimed', 'running', 'exit', 'error', 'suspended', 'resuming']);

// created_at/updated_at are unix seconds; only a sane integer range converts.
const MAX_UNIX_SECONDS = 4102444800;

export class ApiError extends Error {}

export function validateOptions(options) {
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._/-]*)?$/.test(options.apiBase)) return 'apiBase must be an https URL';
  if (!/^org-[A-Za-z0-9-]+$/.test(options.orgId)) return 'orgId must look like org-...';
  if (options.maxAgents < 1 || options.maxAgents > 1000) return 'maxAgents must be from 1 to 1000';
  return null;
}

// collect(host, { options, fetchImpl, tokenSource, deadline }) -> records.
export async function collect(host, { options, fetchImpl, tokenSource, deadline }) {
  const account = { name: host.name, provider: host.provider, reachable: false, error: null, workload: null };
  let token;
  try {
    token = await tokenSource({ service: options.keychainService, account: options.keychainAccount });
  } catch (error) {
    // Only a TokenUnavailable message, which sources write without the token,
    // is passed on; anything else gets a fixed message.
    return [{ ...account, error: `token unavailable: ${error instanceof TokenUnavailable ? error.message : 'the token source failed'}` }];
  }
  const api = client({ base: options.apiBase.replace(/\/$/, ''), token, fetchImpl, deadline });
  try {
    const { sessions, truncated } = await listSessions(api, options.orgId, options.maxAgents);
    const records = sessions.map((session) => sessionRecord(host, session));
    const workload = truncated ? { kind: 'devin-account', state: 'ok', title: `showing ${sessions.length} sessions, more remain`, truncated: true } : null;
    return [{ ...account, reachable: true, workload }, ...records];
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return [{ ...account, reachable: error.reached === true, error: redact(error.message, token) }];
  }
}

function client({ base, token, fetchImpl, deadline }) {
  return async function get(path) {
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) throw Object.assign(new ApiError('timed out'), { reached: true });
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'agent-fleet',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const why = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timed out' : 'network error';
      throw new ApiError(`Devin API unreachable: ${why}`);
    }
    if (response.ok) {
      try {
        return await response.json();
      } catch {
        throw Object.assign(new ApiError(`Devin API ${path}: response is not JSON`), { reached: true });
      }
    }
    throw Object.assign(new ApiError(describeFailure(path, response)), { reached: true });
  };
}

// x-ratelimit-reset is epoch seconds; an absurd value must not crash
// Date.toISOString with a RangeError.
function resetTime(reset) {
  const ms = reset * 1000;
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return null;
  return new Date(ms).toISOString();
}

// Fixed messages per status; the response body is never echoed.
export function describeFailure(path, response) {
  const header = (name) => response.headers?.get?.(name) ?? null;
  const status = response.status;
  const retryAfter = Number(header('retry-after'));
  const reset = Number(header('x-ratelimit-reset'));
  if (status === 429 || (status === 403 && retryAfter > 0)) {
    const resetAt = reset > 0 ? resetTime(reset) : null;
    const until = retryAfter > 0 ? `retry after ${retryAfter}s` : resetAt !== null ? `resets at ${resetAt}` : 'try again later';
    return `Devin API rate limited (${status}); ${until}`;
  }
  switch (status) {
    case 401: return 'Devin API rejected the token (401): check it has not expired';
    case 403: return `Devin API forbidden (403) for ${path}: the token cannot list sessions`;
    case 404: return `Devin API not found (404) for ${path}: the organization or API path may have changed`;
    case 400:
    case 422: return `Devin API rejected the request (${status}) for ${path}`;
    default: return status >= 500 ? `Devin API error (${status}); try again later` : `Devin API unexpected status ${status} for ${path}`;
  }
}

function sessionsPath(orgId, first, cursor) {
  const base = `/v3/organizations/${encodeURIComponent(orgId)}/sessions?first=${first}`;
  return cursor === null ? base : `${base}&after=${encodeURIComponent(cursor)}`;
}

// GET /v3/organizations/{org_id}/sessions, oldest first. The body is
// { items, end_cursor, has_next_page, total }; end_cursor is followed only
// while has_next_page is true.
async function listSessions(api, orgId, maxAgents) {
  const sessions = [];
  let cursor = null;
  let truncated = false;
  // A generous fixed bound on pages; the collect deadline still bounds wall
  // time. Stops that end listing early (empty page, repeated cursor, no
  // end_cursor) clear the cursor, so a cursor left over afterwards means a
  // page is still pending and the result is truncated. Any stop with more
  // pending (has_next_page true) marks truncation instead of silently
  // dropping sessions.
  const maxPages = 1000;
  const seen = new Set();
  for (let page = 0; page < maxPages; page += 1) {
    const left = maxAgents - sessions.length;
    if (left <= 0) {
      // The cap is reached while another page remains: say so on the
      // account record instead of silently dropping sessions.
      truncated = cursor !== null;
      break;
    }
    const first = Math.min(200, left);
    const path = sessionsPath(orgId, first, cursor);
    const body = await api(path);
    const items = Array.isArray(body?.items) ? body.items : null;
    if (items === null) throw Object.assign(new ApiError(`Devin API ${path}: unexpected response shape`), { reached: true });
    const hasNext = body?.has_next_page === true;
    const batch = items.filter((s) => s && typeof s.session_id === 'string');
    if (batch.length === 0) {
      if (hasNext) truncated = true;
      cursor = null;
      break;
    }
    sessions.push(...batch.slice(0, first));
    const next = hasNext && typeof body?.end_cursor === 'string' && body.end_cursor.length > 0 ? body.end_cursor : null;
    if (!hasNext) {
      cursor = null;
      break;
    }
    if (next === null) {
      // The list continues beyond what we fetched, so say so instead of
      // treating it as a clean end.
      truncated = true;
      cursor = null;
      break;
    }
    if (next.length > 1024) {
      // An absurd cursor is not followed; the list continues beyond what we
      // fetched, so say so instead of treating it as a clean end.
      truncated = true;
      cursor = null;
      break;
    }
    if (seen.has(next)) {
      // A repeated cursor would loop; the list may continue beyond what we
      // fetched, so say so instead of treating it as a clean end.
      truncated = true;
      cursor = null;
      break;
    }
    seen.add(next);
    cursor = next;
  }
  truncated ||= cursor !== null;
  return { sessions, truncated };
}

function devinTimestamp(value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_UNIX_SECONDS) return null;
  return new Date(value * 1000).toISOString();
}

function sessionRecord(host, session) {
  const pulls = Array.isArray(session.pull_requests) ? session.pull_requests : [];
  const first = pulls.find((p) => p && typeof p.pr_url === 'string') ?? {};
  const id = sanitizeId(session.session_id);
  return {
    name: `${host.name}/${id}`,
    provider: host.provider,
    reachable: true,
    error: null,
    workload: {
      kind: 'devin-session',
      id,
      title: sanitizeText(session.title),
      state: STATES.has(session.status) ? session.status : 'unknown',
      statusDetail: sanitizeText(session.status_detail),
      repo: null,
      branch: null,
      pullRequestUrl: sanitizeUrl(first.pr_url ?? null),
      pullRequestCount: pulls.length,
      url: sanitizeUrl(session.url),
      runtime: null,
      createdAt: devinTimestamp(session.created_at),
      updatedAt: devinTimestamp(session.updated_at),
    },
  };
}
