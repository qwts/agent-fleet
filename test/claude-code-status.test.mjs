import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, validateConfig } from '../src/config.mjs';
import { collect, encodeDescription, parseDescription } from '../src/providers/claude-code-status.mjs';
import { providerOptions } from '../src/providers/index.mjs';
import { TokenUnavailable } from '../src/token.mjs';
import { run, scratchHome, writeConfig } from './helpers.mjs';

const TOKEN = 'TESTTOKEN-claude-code-status';
const host = { name: 'cc', provider: 'claude-code-status' };
const tokenSource = async () => TOKEN;

const SID = 'cse_abcdefgh1234';
const NOW = Date.parse('2026-10-12T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const desc = (over = {}) => encodeDescription({
  sessionId: SID, branch: 'feat-a', state: 'working', seq: 3, ...over,
});
const status = (over = {}) => ({
  context: 'agent-fleet/claude-code',
  state: 'success',
  description: desc(),
  target_url: 'https://claude.ai/sessions/1',
  created_at: '2026-10-12T11:55:00Z',
  updated_at: '2026-10-12T11:55:00Z',
  ...over,
});
const branchList = (...names) => names.map((name, i) => ({ name, commit: { sha: `sha${i}` } }));

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

const options = (over = {}) => providerOptions('claude-code-status', over);
const go = (fetchImpl, over = {}, source = tokenSource, extra = {}) => collect(host, {
  options: options(over), fetchImpl, tokenSource: source, deadline: Date.now() + 5000, now: NOW, ...extra,
});

test('maps commit statuses to session records with read-only GETs', async () => {
  const calls = [];
  const records = await go(fakeFetch({
    '/repos/o/r/branches?per_page=100&page=1': branchList('feat-a', 'feat-b'),
    '/repos/o/r/commits/sha0/status': {
      state: 'success',
      statuses: [
        status(),
        { context: 'other/ci', state: 'success', description: 'build ok', target_url: null, created_at: '2026-10-12T11:00:00Z' },
      ],
    },
    '/repos/o/r/commits/sha1/status': { state: 'success', statuses: [status({ description: desc({ branch: 'feat-b', state: 'ended', seq: 9 }) })] },
  }, calls), { repos: ['o/r'] });
  assert.deepEqual(records.map((r) => r.name), ['cc', `cc/${SID}`]);
  assert.equal(records[0].reachable, true);
  assert.deepEqual(records[0].workload, { kind: 'claude-code-account', reportedSessions: 1, truncated: false });
  assert.deepEqual(records[1].workload, {
    kind: 'claude-code-session', sessionId: SID, repo: 'o/r', branch: 'feat-a', state: 'working',
    reported: true, url: 'https://claude.ai/sessions/1', seq: 3, updatedAt: '2026-10-12T11:55:00Z',
  });
  for (const { url, init } of calls) {
    assert.match(url, /^https:\/\/api\.github\.com\//);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(init.headers.Accept, 'application/vnd.github+json');
  }
});

test('no repositories means an account record with a coverage note and no requests', async () => {
  let called = false;
  const records = await go(async () => { called = true; });
  assert.equal(called, false);
  assert.equal(records.length, 1);
  assert.equal(records[0].reachable, true);
  assert.deepEqual(records[0].workload, {
    kind: 'claude-code-account', reportedSessions: 0, truncated: false, note: 'no repositories configured',
  });
});

test('a clean poll with no sessions leaves a null workload', async () => {
  const records = await go(fakeFetch({
    '/repos/o/r/branches?per_page=100&page=1': branchList('feat-a'),
    '/repos/o/r/commits/sha0/status': { state: 'success', statuses: [] },
  }), { repos: ['o/r'] });
  assert.equal(records.length, 1);
  assert.equal(records[0].workload, null);
});

const badDescriptions = [
  ['bad v', 'v=2;s=cse_abcdefgh1234;b=feat-a;st=working;n=3'],
  ['short session', 'v=1;s=abc;b=feat-a;st=working;n=3'],
  ['session without prefix', 'v=1;s=abcdefgh1234;b=feat-a;st=working;n=3'],
  ['bad state', 'v=1;s=cse_abcdefgh1234;b=feat-a;st=running;n=3'],
  ['extra keys', 'v=1;s=cse_abcdefgh1234;b=feat-a;st=working;n=3;x=1'],
  ['missing key', 'v=1;s=cse_abcdefgh1234;b=feat-a;st=working'],
  ['wrong order', 's=cse_abcdefgh1234;v=1;b=feat-a;st=working;n=3'],
  ['negative seq', 'v=1;s=cse_abcdefgh1234;b=feat-a;st=working;n=-1'],
  ['fractional seq', 'v=1;s=cse_abcdefgh1234;b=feat-a;st=working;n=1.5'],
  ['empty seq', 'v=1;s=cse_abcdefgh1234;b=feat-a;st=working;n='],
  ['value with equals', 'v=1;s=cse_abcdefgh1234;b=feat-a;st=working;n=3=4'],
  ['too long', `v=1;s=cse_abcdefgh1234;b=${'x'.repeat(140)};st=working;n=3`],
  ['branch mismatch', 'v=1;s=cse_abcdefgh1234;b=other-branch;st=working;n=3'],
  ['leaky payload', 'v=1;s=cse_abcdefgh1234;b=feat-a;st=working;n=3;SECRET-DESC-PAYLOAD'],
];

for (const [label, description] of badDescriptions) {
  test(`a ${label} description is skipped silently and never echoed`, async () => {
    const records = await go(fakeFetch({
      '/repos/o/r/branches?per_page=100&page=1': branchList('feat-a'),
      '/repos/o/r/commits/sha0/status': {
        state: 'success',
        statuses: [status({ description }), { context: 'other/ci', state: 'success', description: 'SECRET-CTX-PAYLOAD' }],
      },
    }), { repos: ['o/r'] });
    assert.equal(records.length, 1, 'account record only');
    assert.doesNotMatch(JSON.stringify(records), /SECRET-DESC-PAYLOAD|SECRET-CTX-PAYLOAD/);
  });
}

test('duplicate sessions keep the status with the latest created_at', async () => {
  const records = await go(fakeFetch({
    '/repos/o/r/branches?per_page=100&page=1': branchList('feat-a'),
    '/repos/o/r/commits/sha0/status': {
      state: 'success',
      statuses: [
        status({ description: desc({ state: 'working', seq: 3 }), created_at: '2026-10-12T11:55:00Z' }),
        status({
          description: desc({ state: 'waiting', seq: 7 }),
          target_url: 'https://claude.ai/sessions/2',
          created_at: '2026-10-12T11:58:00Z',
        }),
      ],
    },
  }), { repos: ['o/r'] });
  assert.equal(records.length, 2);
  assert.equal(records[1].workload.state, 'waiting');
  assert.equal(records[1].workload.reportedState, undefined, 'fresh reports keep no override');
  assert.equal(records[1].workload.seq, 7);
  assert.equal(records[1].workload.url, 'https://claude.ai/sessions/2');
  assert.equal(records[1].workload.updatedAt, '2026-10-12T11:58:00Z');
  assert.deepEqual(records[0].workload, { kind: 'claude-code-account', reportedSessions: 1, truncated: false });
});

test('branch pages use the remaining cap and stop at a short page', async () => {
  const many = (n, from) => Array.from({ length: n }, (_, i) => ({ name: `b${from + i}`, commit: { sha: `s${from + i}` } }));
  const calls = [];
  const fetchImpl = fakeFetch({
    '/repos/o/r/branches?per_page=100&page=1': many(100, 0),
    '/repos/o/r/branches?per_page=50&page=2': many(20, 100),
  }, calls);
  const routes = async (url, init) => {
    if (url.includes('/commits/')) {
      return new Response(JSON.stringify({ state: 'success', statuses: [] }), { status: 200 });
    }
    return fetchImpl(url, init);
  };
  const seen = [];
  const counting = async (url, init) => { seen.push(url); return routes(url, init); };
  const records = await go(counting, { repos: ['o/r'], maxBranches: 150 });
  assert.equal(records[0].workload, null, 'all 120 branches enumerated: nothing cut');
  assert.deepEqual(
    seen.filter((u) => u.includes('/branches')).map((u) => u.split('/branches')[1]),
    ['?per_page=100&page=1', '?per_page=50&page=2'],
  );
});

test('the branch cap truncates and skips later repositories', async () => {
  const calls = [];
  const records = await go(fakeFetch({
    '/repos/o/a/branches?per_page=2&page=1': branchList('a1', 'a2'),
    '/repos/o/a/commits/sha0/status': { state: 'success', statuses: [] },
    '/repos/o/a/commits/sha1/status': { state: 'success', statuses: [] },
    '/repos/o/b/branches': () => assert.fail('o/b is never polled once the cap is reached'),
  }, calls), { repos: ['o/a', 'o/b'], maxBranches: 2 });
  assert.deepEqual(records[0].workload, { kind: 'claude-code-account', reportedSessions: 0, truncated: true });
  assert.ok(!calls.some((c) => c.url.includes('/o/b/')), 'no request for the unpolled repo');
});

test('staleness follows injected now with reported/idle/stale/ended boundaries', async () => {
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const at = (ageMs, over) => status({ description: desc({ state: 'working', ...over }), created_at: iso(NOW - ageMs) });
  const runAt = async (ageMs, over) => go(fakeFetch({
    '/repos/o/r/branches?per_page=100&page=1': branchList('feat-a'),
    '/repos/o/r/commits/sha0/status': { state: 'success', statuses: [at(ageMs, over)] },
  }), { repos: ['o/r'] });
  const fresh = await runAt(30 * minute);
  assert.equal(fresh[1].workload.state, 'working');
  assert.equal(fresh[1].workload.reportedState, undefined);
  const idle = await runAt(30 * minute + 1000);
  assert.equal(idle[1].workload.state, 'idle');
  assert.equal(idle[1].workload.reportedState, 'working');
  const idleEdge = await runAt(24 * hour);
  assert.equal(idleEdge[1].workload.state, 'idle');
  const stale = await runAt(24 * hour + 1000);
  assert.equal(stale[1].workload.state, 'stale');
  assert.equal(stale[1].workload.reportedState, 'working');
  const ended = await runAt(48 * hour, { state: 'ended' });
  assert.equal(ended[1].workload.state, 'ended');
  assert.equal(ended[1].workload.reportedState, undefined, 'ended is never overridden');
});

test('only https claude.ai session URLs survive, through the sanitizer', async () => {
  const urls = [
    ['https://claude.ai/sessions/1', 'https://claude.ai/sessions/1'],
    ['https://app.claude.ai/sessions/2', 'https://app.claude.ai/sessions/2'],
    ['http://claude.ai/sessions/3', null],
    ['https://evil.example/sessions/4', null],
    ['javascript:alert(1)', null],
  ];
  for (const [target, want] of urls) {
    const records = await go(fakeFetch({
      '/repos/o/r/branches?per_page=100&page=1': branchList('feat-a'),
      '/repos/o/r/commits/sha0/status': { state: 'success', statuses: [status({ target_url: target })] },
    }), { repos: ['o/r'] });
    assert.equal(records[1].workload.url, want, target);
  }
});

test('an absurd x-ratelimit-reset falls back instead of crashing', async () => {
  const records = await go(fakeFetch({
    '/repos/o/r/branches': () => new Response('{}', { status: 429, headers: { 'x-ratelimit-reset': '1e20' } }),
  }), { repos: ['o/r'] });
  assert.equal(records.length, 1);
  assert.match(records[0].error, /rate limited \(429\); try again later/);
  assert.equal(records[0].reachable, true);
});

const failures = [
  ['401', () => new Response('{"message":"Bad credentials"}', { status: 401 }), /rejected the token \(401\)/, true],
  ['403', () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '10' } }), /forbidden \(403\).*"Commit statuses" and "Metadata"/, true],
  ['primary rate limit', () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1791720000' } }), /rate limited \(403\); resets at 2026-/, true],
  ['secondary rate limit', () => new Response('{}', { status: 429, headers: { 'retry-after': '60' } }), /rate limited \(429\); retry after 60s/, true],
  ['404', () => new Response('{}', { status: 404 }), /not found \(404\)/, true],
  ['422', () => new Response('{}', { status: 422 }), /rejected the request \(422\)/, true],
  ['500', () => new Response('{}', { status: 502 }), /API error \(502\); try again later/, true],
  ['not JSON', () => new Response('<html>', { status: 200 }), /response is not JSON/, true],
  ['wrong branch shape', () => new Response('{"branches":[]}', { status: 200 }), /unexpected response shape/, true],
  ['wrong status shape', () => new Response('{"state":"success"}', { status: 200 }), /unexpected response shape/, true],
  ['network', () => { throw new TypeError(`fetch failed for ${TOKEN}`); }, /unreachable: network error/, false],
  ['timeout', () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); }, /unreachable: timed out/, false],
];

for (const [label, respond, message, reached] of failures) {
  test(`a ${label} failure becomes one account record with a clean error`, async () => {
    const records = await go(fakeFetch({
      '/repos/o/r/branches': respond,
      '/repos/o/r/commits/sha0/status': respond,
    }), { repos: ['o/r'] });
    assert.equal(records.length, 1);
    assert.match(records[0].error, message);
    assert.equal(records[0].reachable, reached);
    assert.doesNotMatch(JSON.stringify(records), /TESTTOKEN|Bad credentials|<html>/);
  });
}

test('an unexpected token source error is not echoed', async () => {
  const records = await go(async () => assert.fail('no request'), { repos: ['o/r'] }, async () => { throw new Error(`boom ${TOKEN}`); });
  assert.equal(records[0].error, 'token unavailable: the token source failed');
});

test('a missing token is reported without calling the API', async () => {
  let called = false;
  const records = await go(async () => { called = true; }, { repos: ['o/r'] }, async () => { throw new TokenUnavailable('no token in the Keychain'); });
  assert.equal(called, false);
  assert.equal(records[0].reachable, false);
  assert.match(records[0].error, /^token unavailable: no token in the Keychain/);
});

test('config: claude-code-status hosts take no target, and options are validated', () => {
  assert.equal(validateConfig({ schemaVersion: 1, hosts: [host] }).hosts[0].provider, 'claude-code-status');
  assert.throws(() => validateConfig({ schemaVersion: 1, hosts: [{ ...host, target: 'x.example' }] }), ConfigError);
  assert.throws(() => options({ apiBase: 'http://api.github.com' }), /https URL/);
  assert.throws(() => options({ repos: ['not a repo'] }), /owner\/repo/);
  assert.throws(() => options({ maxBranches: 0 }), /maxBranches/);
  assert.throws(() => options({ maxBranches: 1001 }), /maxBranches/);
  assert.throws(() => options({ idleAfterMinutes: 0 }), /idleAfterMinutes/);
  assert.throws(() => options({ staleAfterHours: 0 }), /staleAfterHours/);
  assert.throws(() => options({ maxBranches: '5' }), /integer/);
  assert.throws(() => options({ repos: 'o/r' }), /array/);
  assert.throws(() => options({ token: TOKEN }), /unknown key "token"/, 'the token never lives in config');
  assert.throws(() => options({ toString: 'x' }), /unknown key "toString"/, 'inherited names are not keys');
});

test('status shows Claude Code sessions in the same report shape and never prints the token', async (t) => {
  const { home, env } = scratchHome(t);
  // The fleet path injects no `now`, so the status must be fresh against the
  // real clock to keep its reported state.
  const fresh = new Date().toISOString();
  const fetchImpl = fakeFetch({
    '/repos/o/r/branches?per_page=100&page=1': branchList('feat-a'),
    '/repos/o/r/commits/sha0/status': { state: 'success', statuses: [status({ created_at: fresh, updated_at: fresh })] },
  }, []);
  const withRepos = { providers: { 'claude-code-status': { repos: ['o/r'] } } };
  writeConfig(home, { schemaVersion: 1, providers: withRepos.providers, hosts: [host] });
  const json = await run(['status', '--json'], { env, fetchImpl, tokenSource });
  const report = JSON.parse(json.out);
  assert.deepEqual(report.summary, { hosts: 2, ok: 2, drift: 0, partial: 0, unreachable: 0 });
  assert.equal(report.hosts[1].workload.branch, 'feat-a');
  assert.deepEqual(report.hosts[1].drift, []);
  const text = await run(['status'], { env, fetchImpl, tokenSource });
  assert.match(text.out, new RegExp(`cc/${SID} \\(claude-code-status\\)  \\[OK\\]  working  o/r feat-a`));
  for (const out of [json.out, json.err, text.out, text.err]) assert.doesNotMatch(out, /TESTTOKEN/);
});

test('untrusted session fields are sanitized before output', async () => {
  const evil = {
    id: '../evil', name: 'x', state: 'success', html_url: 'javascript:alert(1)',
    repository: { id: 99 }, created_at: 'yesterday', updated_at: '2026-10-11T10:00:00Z',
  };
  assert.ok(evil);
  const records = await go(fakeFetch({
    '/repos/o/r/branches?per_page=100&page=1': [{ name: 'feat-a', commit: { sha: 'sha0' } }],
    '/repos/o/r/commits/sha0/status': {
      state: 'success',
      statuses: [status({ description: desc(), target_url: 'javascript:alert(1)', created_at: 'yesterday' })],
    },
  }), { repos: ['o/r'] });
  const out = JSON.stringify(records);
  assert.doesNotMatch(out, /javascript:/);
  assert.equal(records[1].workload.url, null);
  assert.equal(records[1].workload.updatedAt, null);
  assert.equal(records[1].workload.state, 'working', 'an unreadable timestamp keeps the reported state');
});

test('encodeDescription round-trips through the parser for every state', () => {
  for (const state of ['started', 'working', 'waiting', 'failed', 'ended']) {
    const description = encodeDescription({ sessionId: SID, branch: 'feat-a', state, seq: 0 });
    assert.deepEqual(parseDescription(description), { sessionId: SID, branch: 'feat-a', state, seq: 0 });
  }
  assert.equal(parseDescription('not a description'), null);
  assert.equal(parseDescription(42), null);
});

test('encodeDescription refuses fields that would break the format', () => {
  assert.throws(() => encodeDescription({ sessionId: 'abc', branch: 'b', state: 'working', seq: 1 }), /sessionId/);
  assert.throws(() => encodeDescription({ sessionId: SID, branch: 'b', state: 'running', seq: 1 }), /state/);
  assert.throws(() => encodeDescription({ sessionId: SID, branch: '', state: 'working', seq: 1 }), /branch/);
  assert.throws(() => encodeDescription({ sessionId: SID, branch: 'a;b', state: 'working', seq: 1 }), /branch/);
  assert.throws(() => encodeDescription({ sessionId: SID, branch: 'a=b', state: 'working', seq: 1 }), /branch/);
  assert.throws(() => encodeDescription({ sessionId: SID, branch: 'b', state: 'working', seq: -1 }), /seq/);
  assert.throws(() => encodeDescription({ sessionId: SID, branch: 'b', state: 'working', seq: 1.5 }), /seq/);
  assert.throws(() => encodeDescription({ sessionId: SID, branch: 'x'.repeat(140), state: 'working', seq: 1 }), /140/);
});
