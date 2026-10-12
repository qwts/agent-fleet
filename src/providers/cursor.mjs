// Cursor Cloud Agents, read from the Cloud Agents REST API:
// https://cursor.com/docs/cloud-agent/api/endpoints
// A poller on the control Mac (ADR-0001 §6). It only sends GET requests,
// with an API key that has read-only agent visibility.
//
// One config host becomes one account record plus one record per agent, all
// in the same report shape as an SSH host; an agent's details go in `workload`.
import { sanitizeId, sanitizeRepo, sanitizeText, sanitizeTimestamp, sanitizeUrl } from '../sanitize.mjs';
import { TokenUnavailable, redact } from '../token.mjs';

export const kind = 'api';

export const DEFAULTS = Object.freeze({
  apiBase: 'https://api.cursor.com',
  keychainService: 'agent-fleet.cursor',
  keychainAccount: 'agent-fleet',
  maxAgents: 100,
});

export const expects = Object.freeze([]);

const STATES = new Set(['ACTIVE', 'IDLE', 'ARCHIVED']);

export class ApiError extends Error {}

export function validateOptions(options) {
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._/-]*)?$/.test(options.apiBase)) return 'apiBase must be an https URL';
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
    const { agents, truncated } = await listAgents(api, options.maxAgents);
    const records = agents.map((agent) => agentRecord(host, agent));
    const workload = truncated ? { kind: 'cursor-account', state: 'ok', title: `showing ${agents.length} agents, more remain`, truncated: true } : null;
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
      throw new ApiError(`Cursor API unreachable: ${why}`);
    }
    if (response.ok) {
      try {
        return await response.json();
      } catch {
        throw Object.assign(new ApiError(`Cursor API ${path}: response is not JSON`), { reached: true });
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
    return `Cursor API rate limited (${status}); ${until}`;
  }
  switch (status) {
    case 401: return 'Cursor API rejected the token (401): check it has not expired';
    case 403: return `Cursor API forbidden (403) for ${path}: the token cannot list agents`;
    case 404: return `Cursor API not found (404) for ${path}: the API path may have changed`;
    case 400:
    case 422: return `Cursor API rejected the request (${status}) for ${path}`;
    default: return status >= 500 ? `Cursor API error (${status}); try again later` : `Cursor API unexpected status ${status} for ${path}`;
  }
}

// GET /v1/agents, newest first. The body is { items, nextCursor };
// nextCursor is omitted when no more pages remain.
async function listAgents(api, maxAgents) {
  const agents = [];
  let cursor = null;
  let truncated = false;
  // A generous fixed bound on pages; the collect deadline still bounds wall
  // time. Stops that end listing early (empty page, repeated cursor, no
  // nextCursor) clear the cursor, so a cursor left over afterwards means a
  // page is still pending and the result is truncated.
  const maxPages = 1000;
  const seen = new Set();
  for (let page = 0; page < maxPages; page += 1) {
    const left = maxAgents - agents.length;
    if (left <= 0) {
      // The cap is reached while another page remains: say so on the
      // account record instead of silently dropping agents.
      truncated = cursor !== null;
      break;
    }
    const limit = Math.min(100, left);
    const path = cursor === null
      ? `/v1/agents?limit=${limit}`
      : `/v1/agents?limit=${limit}&cursor=${encodeURIComponent(cursor)}`;
    const body = await api(path);
    const batch = Array.isArray(body?.items) ? body.items.filter((a) => a && typeof a.id === 'string') : null;
    if (batch === null) throw Object.assign(new ApiError('Cursor API /v1/agents: unexpected response shape'), { reached: true });
    if (batch.length === 0) {
      cursor = null;
      break;
    }
    agents.push(...batch.slice(0, limit));
    const next = typeof body?.nextCursor === 'string' && body.nextCursor.length > 0 ? body.nextCursor : null;
    if (next === null) {
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
      cursor = null;
      break;
    }
    seen.add(next);
    cursor = next;
  }
  truncated ||= cursor !== null;
  return { agents, truncated };
}

function agentRecord(host, agent) {
  const repos = Array.isArray(agent.repos) ? agent.repos : [];
  const repo = repos.find((r) => r && typeof r.url === 'string') ?? {};
  const id = sanitizeId(agent.id);
  return {
    name: `${host.name}/${id}`,
    provider: host.provider,
    reachable: true,
    error: null,
    workload: {
      kind: 'cursor-agent',
      id,
      title: sanitizeText(agent.name),
      state: STATES.has(agent.status) ? agent.status : 'unknown',
      repo: sanitizeRepo(repo.url),
      branch: sanitizeText(repo.startingRef),
      url: sanitizeUrl(agent.url),
      runtime: null,
      createdAt: sanitizeTimestamp(agent.createdAt),
      updatedAt: sanitizeTimestamp(agent.updatedAt),
    },
  };
}
