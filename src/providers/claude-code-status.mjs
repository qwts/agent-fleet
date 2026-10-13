// Claude Code cloud sessions, read from GitHub commit statuses:
// a session hook posts a `agent-fleet/claude-code` status per session
// branch, and this poller reads them back with GET requests only.
// A poller on the control Mac (ADR-0001 §6), with a fine-grained PAT that
// has read-only "Commit statuses" and "Metadata".
//
// One config host becomes one account record plus one record per session, all
// in the same report shape as an SSH host; a session's details go in `workload`.
import { sanitizeId, sanitizeRepo, sanitizeText, sanitizeTimestamp, sanitizeUrl } from '../sanitize.mjs';
import { TokenUnavailable, redact } from '../token.mjs';

export const kind = 'api';

export const DEFAULTS = Object.freeze({
  apiBase: 'https://api.github.com',
  keychainService: 'agent-fleet.claude-code-status',
  keychainAccount: 'agent-fleet',
  // Empty: no repositories are polled; the account record carries a note.
  repos: [],
  maxBranches: 100,
  idleAfterMinutes: 30,
  staleAfterHours: 24,
});

export const expects = Object.freeze([]);

export const STATUS_CONTEXT = 'agent-fleet/claude-code';
const SESSION_ID = /^cse_[A-Za-z0-9]{8,64}$/;
const STATES = new Set(['started', 'working', 'waiting', 'failed', 'ended']);
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{40,64}$/;
const MAX_DESCRIPTION = 140;

export class ApiError extends Error {}

export function validateOptions(options) {
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._/-]*)?$/.test(options.apiBase)) return 'apiBase must be an https URL';
  if (!options.repos.every((r) => REPO.test(r))) return 'repos must be owner/repo names';
  if (options.maxBranches < 1 || options.maxBranches > 1000) return 'maxBranches must be from 1 to 1000';
  if (options.idleAfterMinutes < 1 || options.idleAfterMinutes > 1000000) return 'idleAfterMinutes must be from 1 to 1000000';
  if (options.staleAfterHours < 1 || options.staleAfterHours > 1000000) return 'staleAfterHours must be from 1 to 1000000';
  if (options.idleAfterMinutes >= options.staleAfterHours * 60) return 'idleAfterMinutes must be less than staleAfterHours * 60';
  return null;
}

// collect(host, { options, fetchImpl, tokenSource, deadline, now }) -> records.
// Staleness "now" is the latest HTTP Date header seen on a statuses response
// (last seen wins); `now` is the fallback when no response carried a parseable
// Date, and stays injectable for staleness tests.
export async function collect(host, { options, fetchImpl, tokenSource, deadline, now = Date.now() }) {
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
    const { branches, truncated } = await listBranches(api, options.repos, options.maxBranches);
    const sessions = await collectSessions(api, branches);
    const effectiveNow = api.serverNow() ?? now;
    const records = sessions.map((session) => sessionRecord(host, session, options, effectiveNow));
    let workload = null;
    if (truncated || records.length > 0) {
      workload = { kind: 'claude-code-account', reportedSessions: records.length, truncated };
    } else if (options.repos.length === 0) {
      workload = { kind: 'claude-code-account', reportedSessions: 0, truncated: false, note: 'no repositories configured' };
    }
    return [{ ...account, reachable: true, workload }, ...records];
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return [{ ...account, reachable: error.reached === true, error: redact(error.message, token) }];
  }
}

// The commits-status path carries a branch sha; error text uses this fixed
// label instead so an unexpected sha can never be echoed back.
function safePath(path) {
  return path.replace(/\/commits\/[^/]+\/status$/, '/commits/<sha>/status');
}

function client({ base, token, fetchImpl, deadline }) {
  // Latest HTTP Date header seen on any response (last seen wins); null until
  // the first dated response arrives. collect() uses it as staleness "now".
  let serverNow = null;
  async function get(path) {
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) throw Object.assign(new ApiError('timed out'), { reached: true });
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'agent-fleet',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const why = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timed out' : 'network error';
      throw new ApiError(`GitHub API unreachable: ${why}`);
    }
    const dateMs = Date.parse(response.headers?.get?.('date') ?? '');
    if (!Number.isNaN(dateMs)) serverNow = dateMs;
    if (response.ok) {
      try {
        return await response.json();
      } catch {
        throw Object.assign(new ApiError(`GitHub API ${safePath(path)}: response is not JSON`), { reached: true });
      }
    }
    throw Object.assign(new ApiError(describeFailure(safePath(path), response)), { reached: true });
  }
  get.serverNow = () => serverNow;
  return get;
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
  const remaining = header('x-ratelimit-remaining');
  const reset = Number(header('x-ratelimit-reset'));
  const retryAfter = Number(header('retry-after'));
  if (status === 429 || (status === 403 && (remaining === '0' || retryAfter > 0))) {
    const resetAt = reset > 0 ? resetTime(reset) : null;
    const until = retryAfter > 0 ? `retry after ${retryAfter}s` : resetAt !== null ? `resets at ${resetAt}` : 'try again later';
    return `GitHub API rate limited (${status}); ${until}`;
  }
  switch (status) {
    case 401: return 'GitHub API rejected the token (401): check it has not expired';
    case 403: return `GitHub API forbidden (403) for ${path}: the token needs read-only "Commit statuses" and "Metadata"`;
    case 404: return `GitHub API not found (404) for ${path}: the repository or branch is not visible to this token`;
    case 400:
    case 422: return `GitHub API rejected the request (${status}) for ${path}`;
    default: return status >= 500 ? `GitHub API error (${status}); try again later` : `GitHub API unexpected status ${status} for ${path}`;
  }
}

// GET /repos/{owner}/{repo}/branches, paged. maxBranches is a limit for the
// whole host: each repository gets what is left, and none is asked once it
// is reached. Returns { branches: [{ repo, branch, sha }], truncated }.
async function listBranches(api, repos, maxBranches) {
  const branches = [];
  // Every repo fully enumerated (short page seen) means nothing was cut.
  let enumeratedAll = true;
  for (const repo of repos) {
    let repoDone = false;
    for (let page = 1; branches.length < maxBranches; page += 1) {
      const perPage = Math.min(100, maxBranches - branches.length);
      const path = `/repos/${repo}/branches?per_page=${perPage}&page=${page}`;
      const body = await api(path);
      if (!Array.isArray(body)) throw Object.assign(new ApiError(`GitHub API ${path}: unexpected response shape`), { reached: true });
      // The sha becomes part of the next request path, so only hex shas
      // (40 for SHA-1, up to 64 for SHA-256) are kept; anything else is
      // skipped and therefore never fetched or echoed in an error.
      const batch = body.filter((b) => b && typeof b.name === 'string' && typeof b.commit?.sha === 'string' && SHA.test(b.commit.sha));
      branches.push(...batch.slice(0, perPage).map((b) => ({ repo, branch: b.name, sha: b.commit.sha })));
      if (batch.length < perPage) {
        repoDone = true;
        break;
      }
    }
    if (!repoDone) enumeratedAll = false;
    if (branches.length >= maxBranches) {
      // The cap stopped enumeration while a repo (or a later repo) may
      // still hold branches: say so on the account record instead of
      // silently dropping them.
      enumeratedAll = false;
      break;
    }
  }
  return { branches, truncated: branches.length >= maxBranches && !enumeratedAll };
}

// One combined-status GET per branch, in order. Keeps only our context,
// parses each description strictly, drops branch mismatches, and dedupes by
// session id keeping the status with the latest created_at.
async function collectSessions(api, branches) {
  const bySession = new Map();
  for (const { repo, branch, sha } of branches) {
    const path = `/repos/${repo}/commits/${sha}/status`;
    const body = await api(path);
    const statuses = Array.isArray(body?.statuses) ? body.statuses : null;
    if (statuses === null) throw Object.assign(new ApiError(`GitHub API ${safePath(path)}: unexpected response shape`), { reached: true });
    for (const status of statuses) {
      if (!status || status.context !== STATUS_CONTEXT) continue;
      const parsed = parseDescription(status.description);
      if (parsed === null) continue;
      // Trust neither side on its own: the record branch is the enumerated
      // branch name, and a status pointing elsewhere is skipped.
      if (parsed.branch !== branch) continue;
      const at = typeof status.created_at === 'string' ? Date.parse(status.created_at) : NaN;
      const candidate = { parsed, repo, branch, targetUrl: status.target_url, createdAt: status.created_at, millis: at };
      const prev = bySession.get(parsed.sessionId);
      if (prev === undefined) {
        bySession.set(parsed.sessionId, candidate);
      } else {
        const prevAt = prev.millis;
        const nextAt = candidate.millis;
        if (Number.isNaN(prevAt) && !Number.isNaN(nextAt)) bySession.set(parsed.sessionId, candidate);
        else if (!Number.isNaN(nextAt) && !Number.isNaN(prevAt) && nextAt > prevAt) bySession.set(parsed.sessionId, candidate);
      }
    }
  }
  return [...bySession.values()];
}

// Strict parser for `v=1;s=<session>;b=<branch>;st=<state>;n=<seq>`:
// exact keys in exact order, v exactly '1', a known state, an integer seq,
// and the whole description within 140 chars. Anything else returns null
// and is never echoed.
export function parseDescription(description) {
  if (typeof description !== 'string' || description.length > MAX_DESCRIPTION) return null;
  const parts = description.split(';');
  if (parts.length !== 5) return null;
  const fields = parts.map((part) => part.split('='));
  if (!fields.every((kv) => kv.length === 2)) return null;
  const [[k0, v], [k1, s], [k2, b], [k3, st], [k4, n]] = fields;
  if (k0 !== 'v' || k1 !== 's' || k2 !== 'b' || k3 !== 'st' || k4 !== 'n') return null;
  if (v !== '1') return null;
  if (!SESSION_ID.test(s)) return null;
  if (!STATES.has(st)) return null;
  if (!/^\d{1,10}$/.test(n)) return null;
  if (b.length === 0) return null;
  return { sessionId: s, branch: b, state: st, seq: Number(n) };
}

// Encoder mirroring the session hook in the trial repository. Refuses fields that would break
// the strict format or push the description past 140 chars.
export function encodeDescription({ sessionId, branch, state, seq }) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new Error('encodeDescription: sessionId must look like cse_...');
  if (typeof branch !== 'string' || branch.length === 0 || branch.includes(';') || branch.includes('=')) {
    throw new Error('encodeDescription: branch must be a non-empty string without ";" or "="');
  }
  if (typeof state !== 'string' || !STATES.has(state)) throw new Error('encodeDescription: unknown state');
  if (!Number.isInteger(seq) || seq < 0 || seq > 9999999999) throw new Error('encodeDescription: seq must be a non-negative integer');
  const description = `v=1;s=${sessionId};b=${branch};st=${state};n=${seq}`;
  if (description.length > MAX_DESCRIPTION) throw new Error('encodeDescription: description would exceed 140 chars');
  if (parseDescription(description) === null) throw new Error('encodeDescription: fields do not round-trip');
  return description;
}

function sessionUrl(targetUrl) {
  if (typeof targetUrl !== 'string') return null;
  let url = null;
  try {
    url = new URL(targetUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  if (host !== 'claude.ai' && !host.endsWith('.claude.ai')) return null;
  return sanitizeUrl(targetUrl);
}

function sessionRecord(host, session, options, now) {
  const { parsed, repo, branch } = session;
  const sessionId = sanitizeId(parsed.sessionId);
  let state = parsed.state;
  let reportedState;
  if (state !== 'ended') {
    const millis = session.millis;
    if (!Number.isNaN(millis)) {
      const ageMs = now - millis;
      if (ageMs > options.staleAfterHours * 3600 * 1000) state = 'stale';
      else if (ageMs > options.idleAfterMinutes * 60 * 1000) state = 'idle';
    }
    if (state !== parsed.state) reportedState = parsed.state;
  }
  const workload = {
    kind: 'claude-code-session',
    sessionId,
    repo: sanitizeRepo(repo),
    branch: sanitizeText(branch),
    state,
    reported: true,
    url: sessionUrl(session.targetUrl),
    seq: parsed.seq,
    updatedAt: sanitizeTimestamp(session.createdAt),
  };
  if (reportedState !== undefined) workload.reportedState = reportedState;
  return {
    name: `${host.name}/${sessionId}`,
    provider: host.provider,
    reachable: true,
    error: null,
    workload,
  };
}
