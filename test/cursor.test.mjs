import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, validateConfig } from '../src/config.mjs';
import { collect } from '../src/providers/cursor.mjs';
import { providerOptions } from '../src/providers/index.mjs';
import { TokenUnavailable } from '../src/token.mjs';
import { run, scratchHome, writeConfig } from './helpers.mjs';

const TOKEN = 'crsr_TESTTOKEN0123456789';
const host = { name: 'cursor', provider: 'cursor' };
const tokenSource = async () => TOKEN;

const AGENTS = [
  {
    id: 'bc-aaa', name: 'Fix the flaky test', status: 'ACTIVE', url: 'https://cursor.com/agents/bc-aaa',
    createdAt: '2026-10-11T10:00:00Z', updatedAt: '2026-10-11T10:05:00Z',
    repos: [{ url: 'https://github.com/o/r', startingRef: 'main' }],
  },
  {
    id: 'bc-bbb', name: 'Docs', status: 'IDLE', url: 'https://cursor.com/agents/bc-bbb',
    createdAt: '2026-10-10T10:00:00Z', updatedAt: '2026-10-10T10:01:00Z', repos: [],
  },
  { id: 'bc-ccc', status: 'SOMETHING_NEW', createdAt: '2026-10-09T10:00:00Z' },
];

// A stub Cursor API. routes maps a path (with query) to a body or a function.
function fakeFetch(routes, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    const path = url.replace('https://api.cursor.com', '');
    const route = routes[path] ?? routes[path.split('?')[0]];
    if (route === undefined) return new Response('{"message":"Not Found"}', { status: 404 });
    if (typeof route === 'function') return route(path, init);
    return new Response(JSON.stringify(route), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

const options = (over = {}) => providerOptions('cursor', over);
const go = (fetchImpl, over = {}, source = tokenSource) => collect(host, { options: options(over), fetchImpl, tokenSource: source, deadline: Date.now() + 5000 });

test('lists agents with a read-only GET and maps them to records', async () => {
  const calls = [];
  const records = await go(fakeFetch({ '/v1/agents?limit=100': { items: AGENTS } }, calls));
  assert.deepEqual(records.map((r) => r.name), ['cursor', 'cursor/bc-aaa', 'cursor/bc-bbb', 'cursor/bc-ccc']);
  assert.equal(records[0].reachable, true);
  assert.equal(records[0].workload, null, 'no truncation without another page');
  assert.deepEqual(records[1].workload, {
    kind: 'cursor-agent', id: 'bc-aaa', title: 'Fix the flaky test', state: 'ACTIVE', repo: 'https://github.com/o/r',
    branch: 'main', url: 'https://cursor.com/agents/bc-aaa',
    runtime: null, createdAt: '2026-10-11T10:00:00Z', updatedAt: '2026-10-11T10:05:00Z',
  });
  assert.equal(records[2].workload.repo, null, 'an agent without repos has no repo');
  assert.equal(records[3].workload.state, 'unknown');
  assert.equal(records[3].workload.title, null);
  assert.deepEqual(calls.map((c) => c.url), ['https://api.cursor.com/v1/agents?limit=100']);
  for (const { init } of calls) {
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(init.headers.Accept, 'application/json');
  }
});

test('cursor pagination follows nextCursor and marks truncation on the account record', async () => {
  const many = (n, from) => Array.from({ length: n }, (_, i) => ({ id: `bc-${from + i}`, status: 'IDLE', createdAt: 'x' }));
  const calls = [];
  const records = await go(fakeFetch({
    '/v1/agents?limit=5': { items: many(3, 0), nextCursor: 'page-2' },
    '/v1/agents?limit=2&cursor=page-2': { items: many(2, 3) },
  }, calls), { maxAgents: 5 });
  assert.equal(records.length, 6, 'account record plus 5 agents');
  assert.equal(records[0].workload, null, 'the last page has no nextCursor, so nothing is truncated');
  assert.deepEqual(calls.map((c) => c.url), [
    'https://api.cursor.com/v1/agents?limit=5',
    'https://api.cursor.com/v1/agents?limit=2&cursor=page-2',
  ]);
});

test('reaching maxAgents while another page remains records truncation instead of dropping silently', async () => {
  const many = (n, from) => Array.from({ length: n }, (_, i) => ({ id: `bc-${from + i}`, status: 'ACTIVE', createdAt: 'x' }));
  const records = await go(fakeFetch({
    '/v1/agents?limit=3': { items: many(3, 0), nextCursor: 'page-2' },
    '/v1/agents': () => assert.fail('the cap is reached before the next page'),
  }), { maxAgents: 3 });
  assert.equal(records.length, 4, 'account record plus 3 agents');
  assert.equal(records[0].workload.truncated, true);
  assert.match(records[0].workload.title, /more remain/);
});

test('an empty page stops pagination without another request', async () => {
  const calls = [];
  const records = await go(fakeFetch({
    '/v1/agents?limit=5': { items: [{ id: 'bc-a', status: 'IDLE' }, { id: 'bc-b', status: 'IDLE' }], nextCursor: 'page-2' },
    '/v1/agents?limit=3&cursor=page-2': { items: [], nextCursor: 'page-3' },
    '/v1/agents': () => assert.fail('an empty page must stop pagination'),
  }, calls), { maxAgents: 5 });
  assert.equal(records.length, 3, 'account record plus 2 agents');
  assert.equal(calls.length, 2);
});

test('a repeated nextCursor stops pagination instead of looping', async () => {
  const calls = [];
  const records = await go(fakeFetch({
    '/v1/agents?limit=5': { items: [{ id: 'bc-a', status: 'IDLE' }], nextCursor: 'loop' },
    '/v1/agents?limit=4&cursor=loop': { items: [{ id: 'bc-b', status: 'IDLE' }], nextCursor: 'loop' },
  }, calls), { maxAgents: 5 });
  assert.equal(records.length, 3, 'account record plus 2 agents');
  assert.equal(calls.length, 2, 'the repeated cursor is not followed');
});

test('pagination stops at the page cap when the server always has another page', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    const n = calls.length;
    const items = [{ id: `bc-cap-${n}-a`, status: 'IDLE' }, { id: `bc-cap-${n}-b`, status: 'IDLE' }];
    return new Response(JSON.stringify({ items, nextCursor: `cap-${n}` }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const records = await go(fetchImpl, { maxAgents: 5 });
  assert.equal(calls.length, 2, 'ceil(5/5)+1 pages at most');
  assert.equal(records.length, 5, 'account record plus 4 agents');
});

test('a page with more items than requested stays capped at maxAgents', async () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ id: `bc-over-${i}`, status: 'ACTIVE', createdAt: '2026-10-11T10:00:00Z' }));
  const calls = [];
  const records = await go(fakeFetch({ '/v1/agents?limit=3': { items: many } }, calls), { maxAgents: 3 });
  assert.equal(records.length, 4, 'account record plus 3 agents');
  assert.equal(records[0].workload, null, 'no nextCursor, so nothing is truncated');
  assert.equal(calls.length, 1);
});

test('maxAgents=1000 bounds a server that always has another page', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const n = calls.length;
    const items = Array.from({ length: 100 }, (_, i) => ({ id: `bc-k-${n}-${i}`, status: 'IDLE', createdAt: '2026-10-11T10:00:00Z' }));
    return new Response(JSON.stringify({ items, nextCursor: `k-${n}` }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const records = await go(fetchImpl, { maxAgents: 1000 });
  assert.ok(calls.length <= 11, `at most ceil(1000/100)+1 pages, got ${calls.length}`);
  assert.ok(records.length <= 1001, 'account record plus at most 1000 agents');
  assert.equal(records.length, 1001, 'ten full pages fill the bound');
});

test('untrusted agent fields are sanitized before output', async () => {
  const evil = {
    id: '../../etc', name: 'fix\x1b]0;pwned\x07stuff', status: 'ACTIVE', url: 'javascript:alert(1)',
    createdAt: '2026-10-11T10:00:00Z; rm -rf', updatedAt: 12345,
    repos: [{ url: 'javascript:alert(2)', startingRef: '\x1b[2Jbranch' }],
  };
  const records = await go(fakeFetch({ '/v1/agents?limit=100': { items: [evil] } }));
  const out = JSON.stringify(records);
  assert.doesNotMatch(out, /\x1b|javascript:/);
  assert.equal(records[1].name, 'cursor/unknown', 'an unsafe id is not used in the record name');
  assert.deepEqual(records[1].workload, {
    kind: 'cursor-agent', id: 'unknown', title: 'fix]0;pwnedstuff', state: 'ACTIVE', repo: null,
    branch: '[2Jbranch', url: null, runtime: null, createdAt: null, updatedAt: null,
  });
});

const failures = [
  ['401', () => new Response('{"message":"Unauthorized"}', { status: 401 }), /rejected the token \(401\)/, true],
  ['403', () => new Response('{}', { status: 403 }), /forbidden \(403\).*cannot list agents/, true],
  ['rate limit', () => new Response('{}', { status: 429, headers: { 'retry-after': '60' } }), /rate limited \(429\); retry after 60s/, true],
  ['404', () => new Response('{}', { status: 404 }), /not found \(404\).*path may have changed/, true],
  ['422', () => new Response('{}', { status: 422 }), /rejected the request \(422\)/, true],
  ['500', () => new Response('{}', { status: 502 }), /API error \(502\); try again later/, true],
  ['not JSON', () => new Response('<html>', { status: 200 }), /response is not JSON/, true],
  ['wrong shape', () => new Response('[]', { status: 200 }), /unexpected response shape/, true],
  ['network', () => { throw new TypeError(`fetch failed for ${TOKEN}`); }, /unreachable: network error/, false],
  ['timeout', () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); }, /unreachable: timed out/, false],
];

for (const [label, respond, message, reached] of failures) {
  test(`a ${label} failure becomes one account record with a clean error`, async () => {
    const records = await go(fakeFetch({ '/v1/agents': respond }));
    assert.equal(records.length, 1);
    assert.match(records[0].error, message);
    assert.equal(records[0].reachable, reached);
    assert.doesNotMatch(JSON.stringify(records), /TESTTOKEN|Unauthorized|<html>/);
  });
}

test('an unexpected token source error is not echoed', async () => {
  const records = await go(async () => assert.fail('no request'), {}, async () => { throw new Error(`boom ${TOKEN}`); });
  assert.equal(records[0].error, 'token unavailable: the token source failed');
});

test('a missing token is reported without calling the API', async () => {
  let called = false;
  const records = await go(async () => { called = true; }, {}, async () => { throw new TokenUnavailable('no token in the Keychain'); });
  assert.equal(called, false);
  assert.equal(records[0].reachable, false);
  assert.match(records[0].error, /^token unavailable: no token in the Keychain/);
});

test('config: cursor hosts take no target, and options are validated', () => {
  assert.equal(validateConfig({ schemaVersion: 1, hosts: [host] }).hosts[0].provider, 'cursor');
  assert.throws(() => validateConfig({ schemaVersion: 1, hosts: [{ ...host, target: 'x.example' }] }), ConfigError);
  assert.throws(() => options({ apiBase: 'http://api.cursor.com' }), /https URL/);
  assert.throws(() => options({ maxAgents: 0 }), /maxAgents/);
  assert.throws(() => options({ maxAgents: '5' }), /integer/);
  assert.throws(() => options({ token: TOKEN }), /unknown key "token"/, 'the token never lives in config');
  assert.throws(() => options({ toString: 'x' }), /unknown key "toString"/, 'inherited names are not keys');
});

test('status shows Cursor agents in the same report shape and never prints the token', async (t) => {
  const { home, env } = scratchHome(t);
  writeConfig(home, { schemaVersion: 1, hosts: [host] });
  const fetchImpl = fakeFetch({ '/v1/agents?limit=100': { items: [AGENTS[0]] } });
  const json = await run(['status', '--json'], { env, fetchImpl, tokenSource });
  const report = JSON.parse(json.out);
  assert.deepEqual(report.summary, { hosts: 2, ok: 2, drift: 0, partial: 0, unreachable: 0 });
  assert.equal(report.hosts[1].workload.branch, 'main');
  assert.deepEqual(report.hosts[1].drift, []);
  const text = await run(['status'], { env, fetchImpl, tokenSource });
  assert.match(text.out, /cursor\/bc-aaa \(cursor\)  \[OK\]  ACTIVE/);
  for (const out of [json.out, json.err, text.out, text.err]) assert.doesNotMatch(out, /TESTTOKEN/);
});
