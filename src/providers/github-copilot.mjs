// GitHub Copilot cloud agent tasks, read from the agent tasks REST API
// (public preview): https://docs.github.com/en/rest/agent-tasks/agent-tasks
// A poller on the control Mac (ADR-0001 §6). It only sends GET requests,
// with a fine-grained PAT that has read-only "Agent tasks" and "Metadata".
//
// One config host becomes one account record plus one record per task, all
// in the same report shape as an SSH host; a task's details go in `workload`.
import { sanitizeId, sanitizeRepo, sanitizeText, sanitizeTimestamp, sanitizeUrl } from '../sanitize.mjs';
import { TokenUnavailable, redact } from '../token.mjs';

export const kind = 'api';

export const DEFAULTS = Object.freeze({
  apiBase: 'https://api.github.com',
  keychainService: 'agent-fleet.github-copilot',
  keychainAccount: 'agent-fleet',
  // Empty: every task the token's owner can see. Otherwise owner/repo names.
  repos: [],
  maxTasks: 100,
});

export const expects = Object.freeze([]);

export const API_VERSION = '2026-03-10';
const STATES = new Set(['queued', 'in_progress', 'completed', 'failed', 'idle', 'waiting_for_user', 'timed_out', 'cancelled']);
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export class ApiError extends Error {}

export function validateOptions(options) {
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._/-]*)?$/.test(options.apiBase)) return 'apiBase must be an https URL';
  if (!options.repos.every((r) => REPO.test(r))) return 'repos must be owner/repo names';
  if (options.maxTasks < 1 || options.maxTasks > 1000) return 'maxTasks must be from 1 to 1000';
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
    const tasks = [];
    if (options.repos.length === 0) {
      tasks.push(...await listTasks(api, '/agents/tasks', options.maxTasks));
    } else {
      // maxTasks is a limit for the whole host: each repository gets what is
      // left, and none is asked once it is reached.
      for (const repo of options.repos) {
        const left = options.maxTasks - tasks.length;
        if (left <= 0) break;
        for (const task of await listTasks(api, `/agents/repos/${repo}/tasks`, left)) tasks.push({ ...task, repoName: repo });
      }
    }
    const names = await repoNames(api, tasks);
    const records = tasks.map((task) => taskRecord(host, task, names));
    return [{ ...account, reachable: true }, ...records];
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
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': API_VERSION,
          'User-Agent': 'agent-fleet',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const why = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timed out' : 'network error';
      throw new ApiError(`GitHub API unreachable: ${why}`);
    }
    if (response.ok) {
      try {
        return await response.json();
      } catch {
        throw Object.assign(new ApiError(`GitHub API ${path}: response is not JSON`), { reached: true });
      }
    }
    throw Object.assign(new ApiError(describeFailure(path, response)), { reached: true });
  };
}

// Fixed messages per status; the response body is never echoed.
export function describeFailure(path, response) {
  const header = (name) => response.headers?.get?.(name) ?? null;
  const status = response.status;
  const remaining = header('x-ratelimit-remaining');
  const reset = Number(header('x-ratelimit-reset'));
  const retryAfter = Number(header('retry-after'));
  if (status === 429 || (status === 403 && (remaining === '0' || retryAfter > 0))) {
    const until = retryAfter > 0 ? `retry after ${retryAfter}s` : reset > 0 ? `resets at ${new Date(reset * 1000).toISOString()}` : 'try again later';
    return `GitHub API rate limited (${status}); ${until}`;
  }
  switch (status) {
    case 401: return 'GitHub API rejected the token (401): check it has not expired';
    case 403: return `GitHub API forbidden (403) for ${path}: the token needs read-only "Agent tasks" and "Metadata"`;
    case 404: return `GitHub API not found (404) for ${path}: the preview API or the repository is not visible to this token`;
    case 400:
    case 422: return `GitHub API rejected the request (${status}) for ${path}`;
    default: return status >= 500 ? `GitHub API error (${status}); try again later` : `GitHub API unexpected status ${status} for ${path}`;
  }
}

async function listTasks(api, path, maxTasks) {
  const tasks = [];
  for (let page = 1; tasks.length < maxTasks; page += 1) {
    const perPage = Math.min(100, maxTasks - tasks.length);
    const body = await api(`${path}?per_page=${perPage}&page=${page}`);
    const batch = Array.isArray(body?.tasks) ? body.tasks.filter((t) => t && typeof t.id === 'string') : null;
    if (batch === null) throw Object.assign(new ApiError(`GitHub API ${path}: unexpected response shape`), { reached: true });
    tasks.push(...batch.slice(0, perPage));
    if (batch.length < perPage) break;
  }
  return tasks;
}

// Tasks carry only repository.id; the name comes from GET /repositories/{id}
// (Metadata: read). A lookup that fails leaves the id.
async function repoNames(api, tasks) {
  const names = new Map();
  for (const task of tasks) {
    const id = task.repository?.id;
    if (task.repoName || !Number.isInteger(id) || names.has(id)) continue;
    try {
      const repo = await api(`/repositories/${id}`);
      names.set(id, typeof repo?.full_name === 'string' ? repo.full_name : null);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      names.set(id, null);
    }
  }
  return names;
}

function taskRecord(host, task, names) {
  const artifacts = Array.isArray(task.artifacts) ? task.artifacts : [];
  const branch = artifacts.find((a) => a?.type === 'branch')?.data ?? {};
  const pull = artifacts.find((a) => a?.type === 'pull')?.data ?? {};
  const repoId = task.repository?.id;
  const id = sanitizeId(task.id);
  const repo = task.repoName ?? names.get(repoId) ?? (Number.isInteger(repoId) ? `id:${repoId}` : null);
  return {
    name: `${host.name}/${id}`,
    provider: host.provider,
    reachable: true,
    error: null,
    workload: {
      kind: 'copilot-agent-task',
      id,
      title: sanitizeText(task.name),
      state: STATES.has(task.state) ? task.state : 'unknown',
      repo: sanitizeRepo(repo),
      branch: sanitizeText(branch.head_ref),
      baseBranch: sanitizeText(branch.base_ref),
      // The pull artifact's id, as the API gives it (not the PR number).
      pullRequestId: Number.isInteger(pull.id) ? pull.id : null,
      url: sanitizeUrl(task.html_url),
      // Not in the documented API: the runner comes from the repository's
      // copilot-setup-steps.yml.
      runtime: null,
      createdAt: sanitizeTimestamp(task.created_at),
      updatedAt: sanitizeTimestamp(task.updated_at),
    },
  };
}
