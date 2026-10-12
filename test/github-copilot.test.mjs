import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, validateConfig } from '../src/config.mjs';
import { API_VERSION, collect } from '../src/providers/github-copilot.mjs';
import { providerOptions } from '../src/providers/index.mjs';
import { TokenUnavailable, keychainTokenSource, redact } from '../src/token.mjs';
import { run, scratchHome, writeConfig } from './helpers.mjs';

const TOKEN = 'github_pat_TESTTOKEN0123456789';
const host = { name: 'copilot', provider: 'github-copilot' };
const tokenSource = async () => TOKEN;

const TASKS = [
  {
    id: 'task-1', name: 'Fix the flaky test', state: 'in_progress', html_url: 'https://github.com/o/r/tasks/1',
    repository: { id: 42 }, created_at: '2026-10-11T10:00:00Z', updated_at: '2026-10-11T10:05:00Z',
    artifacts: [
      { provider: 'github', type: 'branch', data: { head_ref: 'copilot/fix-flaky', base_ref: 'main' } },
      { provider: 'github', type: 'pull', data: { id: 9001, global_id: 'PR_x' } },
    ],
  },
  { id: 'task-2', name: 'Docs', state: 'completed', repository: { id: 42 }, created_at: '2026-10-10T10:00:00Z', artifacts: [] },
  { id: 'task-3', state: 'brand_new_state', repository: { id: 7 }, created_at: '2026-10-09T10:00:00Z' },
];

// A stub GitHub API. routes maps a path (with query) to a body or a function.
function fakeFetch(routes, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    const path = url.replace('https://api.github.com', '');
    const route = routes[path] ?? routes[path.split('?')[0]];
    if (route === undefined) return new Response('{"message":"Not Found"}', { status: 404 });
    if (typeof route === 'function') return route(path, init);
    return new Response(JSON.stringify(route), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

const options = (over = {}) => providerOptions('github-copilot', over);
const go = (fetchImpl, over = {}, source = tokenSource) => collect(host, { options: options(over), fetchImpl, tokenSource: source, deadline: Date.now() + 5000 });

test('lists the token owner\'s tasks with read-only GETs and maps them to records', async () => {
  const calls = [];
  const records = await go(fakeFetch({
    '/agents/tasks?per_page=100&page=1': { tasks: TASKS, total_active_count: 1, total_archived_count: 0 },
    '/repositories/42': { full_name: 'o/r', private: true },
  }, calls));
  assert.deepEqual(records.map((r) => r.name), ['copilot', 'copilot/task-1', 'copilot/task-2', 'copilot/task-3']);
  assert.equal(records[0].reachable, true);
  assert.equal(records[0].workload, null);
  assert.deepEqual(records[1].workload, {
    kind: 'copilot-agent-task', id: 'task-1', title: 'Fix the flaky test', state: 'in_progress', repo: 'o/r',
    branch: 'copilot/fix-flaky', baseBranch: 'main', pullRequestId: 9001, url: 'https://github.com/o/r/tasks/1',
    runtime: null, createdAt: '2026-10-11T10:00:00Z', updatedAt: '2026-10-11T10:05:00Z',
  });
  assert.equal(records[3].workload.state, 'unknown');
  assert.equal(records[3].workload.repo, 'id:7', 'a failed repo lookup keeps the id');
  assert.equal(calls.filter((c) => c.url.endsWith('/repositories/42')).length, 1, 'one lookup per repository');
  for (const { init } of calls) {
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(init.headers['X-GitHub-Api-Version'], API_VERSION);
    assert.equal(init.headers.Accept, 'application/vnd.github+json');
  }
});

test('configured repositories use the per-repository endpoint and need no lookup', async () => {
  const calls = [];
  const records = await go(fakeFetch({ '/agents/repos/o/r/tasks?per_page=100&page=1': { tasks: [TASKS[1]] } }, calls), { repos: ['o/r'] });
  assert.equal(records[1].workload.repo, 'o/r');
  assert.deepEqual(calls.map((c) => c.url), ['https://api.github.com/agents/repos/o/r/tasks?per_page=100&page=1']);
});

test('pages until maxTasks or a short page', async () => {
  const many = (n, from) => Array.from({ length: n }, (_, i) => ({ id: `t${from + i}`, state: 'completed', created_at: 'x' }));
  const calls = [];
  const records = await go(fakeFetch({
    '/agents/tasks?per_page=100&page=1': { tasks: many(100, 0) },
    '/agents/tasks?per_page=50&page=2': { tasks: many(50, 100) },
  }, calls), { maxTasks: 150 });
  assert.equal(records.length, 151);
  assert.equal(calls.length, 2);
});

const failures = [
  ['401', () => new Response('{"message":"Bad credentials"}', { status: 401 }), /rejected the token \(401\)/, true],
  ['403', () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '10' } }), /forbidden \(403\).*"Agent tasks" and "Metadata"/, true],
  ['primary rate limit', () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1791720000' } }), /rate limited \(403\); resets at 2026-/, true],
  ['secondary rate limit', () => new Response('{}', { status: 429, headers: { 'retry-after': '60' } }), /rate limited \(429\); retry after 60s/, true],
  ['404', () => new Response('{}', { status: 404 }), /not found \(404\).*preview API/, true],
  ['422', () => new Response('{}', { status: 422 }), /rejected the request \(422\)/, true],
  ['500', () => new Response('{}', { status: 502 }), /API error \(502\); try again later/, true],
  ['not JSON', () => new Response('<html>', { status: 200 }), /response is not JSON/, true],
  ['wrong shape', () => new Response('[]', { status: 200 }), /unexpected response shape/, true],
  ['network', () => { throw new TypeError(`fetch failed for ${TOKEN}`); }, /unreachable: network error/, false],
  ['timeout', () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); }, /unreachable: timed out/, false],
];

for (const [label, respond, message, reached] of failures) {
  test(`a ${label} failure becomes one account record with a clean error`, async () => {
    const records = await go(fakeFetch({ '/agents/tasks': respond }));
    assert.equal(records.length, 1);
    assert.match(records[0].error, message);
    assert.equal(records[0].reachable, reached);
    assert.doesNotMatch(JSON.stringify(records), /TESTTOKEN|Bad credentials|<html>/);
  });
}

test('a missing token is reported without calling the API', async () => {
  let called = false;
  const records = await go(async () => { called = true; }, {}, async () => { throw new TokenUnavailable('no token in the Keychain'); });
  assert.equal(called, false);
  assert.equal(records[0].reachable, false);
  assert.match(records[0].error, /^token unavailable: no token in the Keychain/);
});

test('the Keychain source asks security for one item and hides its errors', async () => {
  const seen = [];
  const ok = keychainTokenSource({ platform: 'darwin', execFileImpl: (bin, args, opts, cb) => { seen.push([bin, ...args]); cb(null, `${TOKEN}\n`); } });
  assert.equal(await ok({ service: 'svc', account: 'acct' }), TOKEN);
  assert.deepEqual(seen, [['/usr/bin/security', 'find-generic-password', '-s', 'svc', '-a', 'acct', '-w']]);
  const missing = keychainTokenSource({ platform: 'darwin', execFileImpl: (b, a, o, cb) => cb(Object.assign(new Error('security: SecKeychainSearchCopyNext: secret detail'), { code: 44 }), '') });
  await assert.rejects(missing({ service: 'svc', account: 'acct' }), (e) => e instanceof TokenUnavailable && !/secret detail/.test(e.message));
  const empty = keychainTokenSource({ platform: 'darwin', execFileImpl: (b, a, o, cb) => cb(null, '\n') });
  await assert.rejects(empty({ service: 'svc', account: 'acct' }), /is empty/);
  const linux = keychainTokenSource({ platform: 'linux', execFileImpl: () => assert.fail('must not run') });
  await assert.rejects(linux({ service: 'svc', account: 'acct' }), /needs macOS/);
});

test('redact removes a secret from text', () => {
  assert.equal(redact(`a ${TOKEN} b ${TOKEN}`, TOKEN), 'a [redacted] b [redacted]');
  assert.equal(redact('plain', ''), 'plain');
});

test('config: copilot hosts take no target, and options are validated', () => {
  assert.equal(validateConfig({ schemaVersion: 1, hosts: [host] }).hosts[0].provider, 'github-copilot');
  assert.throws(() => validateConfig({ schemaVersion: 1, hosts: [{ ...host, target: 'x.example' }] }), ConfigError);
  assert.throws(() => validateConfig({ schemaVersion: 1, hosts: [{ name: 'm', provider: 'ssh-mac' }] }), ConfigError);
  assert.throws(() => options({ apiBase: 'http://api.github.com' }), /https URL/);
  assert.throws(() => options({ repos: ['not a repo'] }), /owner\/repo/);
  assert.throws(() => options({ maxTasks: 0 }), /maxTasks/);
  assert.throws(() => options({ maxTasks: '5' }), /integer/);
  assert.throws(() => options({ token: TOKEN }), /unknown key "token"/, 'the token never lives in config');
});

test('status shows Copilot tasks in the same report shape and never prints the token', async (t) => {
  const { home, env } = scratchHome(t);
  writeConfig(home, { schemaVersion: 1, hosts: [host] });
  const fetchImpl = fakeFetch({ '/agents/tasks?per_page=100&page=1': { tasks: [TASKS[0]] }, '/repositories/42': { full_name: 'o/r' } });
  const json = await run(['status', '--json'], { env, fetchImpl, tokenSource });
  const report = JSON.parse(json.out);
  assert.deepEqual(report.summary, { hosts: 2, ok: 2, drift: 0, partial: 0, unreachable: 0 });
  assert.equal(report.hosts[1].workload.branch, 'copilot/fix-flaky');
  assert.deepEqual(report.hosts[1].drift, []);
  const text = await run(['status'], { env, fetchImpl, tokenSource });
  assert.match(text.out, /copilot\/task-1 \(github-copilot\)  \[OK\]  in_progress  o\/r copilot\/fix-flaky/);
  for (const out of [json.out, json.err, text.out, text.err]) assert.doesNotMatch(out, /TESTTOKEN/);
});
