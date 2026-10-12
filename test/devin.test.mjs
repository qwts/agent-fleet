import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, validateConfig } from '../src/config.mjs';
import { collect } from '../src/providers/devin.mjs';
import { providerOptions } from '../src/providers/index.mjs';
import { TokenUnavailable } from '../src/token.mjs';
import { run, scratchHome, writeConfig } from './helpers.mjs';

const TOKEN = 'dvn_TESTTOKEN0123456789';
const ORG = 'org-test123';
const host = { name: 'devin', provider: 'devin' };
const tokenSource = async () => TOKEN;

const SESSIONS = [
  {
    session_id: 'devin-aaa', title: 'Fix the flaky test', status: 'running', status_detail: 'Working on it',
    url: 'https://app.devin.ai/sessions/devin-aaa', created_at: 1760090400, updated_at: 1760090700,
    pull_requests: [{ pr_url: 'https://github.com/o/r/pull/1', pr_state: 'open' }],
  },
  {
    session_id: 'devin-bbb', title: 'Docs', status: 'exit', status_detail: '',
    url: 'https://app.devin.ai/sessions/devin-bbb', created_at: 1760004000, updated_at: 1760004060,
    pull_requests: [],
  },
  { session_id: 'devin-ccc', status: 'SOMETHING_NEW', created_at: 1759917600 },
];

const iso = (s) => new Date(s * 1000).toISOString();

// A stub Devin API. routes maps a path (with query) to a body or a function.
function fakeFetch(routes, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    const path = url.replace('https://api.devin.ai', '');
    const route = routes[path] ?? routes[path.split('?')[0]];
    if (route === undefined) return new Response('{"message":"Not Found"}', { status: 404 });
    if (typeof route === 'function') return route(path, init);
    return new Response(JSON.stringify(route), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

const options = (over = {}) => providerOptions('devin', { orgId: ORG, ...over });
const go = (fetchImpl, over = {}, source = tokenSource) => collect(host, { options: options(over), fetchImpl, tokenSource: source, deadline: Date.now() + 5000 });

test('lists sessions with a read-only GET and maps them to records', async () => {
  const calls = [];
  const records = await go(fakeFetch({ [`/v3/organizations/${ORG}/sessions?first=100`]: { items: SESSIONS, end_cursor: null, has_next_page: false, total: 3 } }, calls));
  assert.deepEqual(records.map((r) => r.name), ['devin', 'devin/devin-aaa', 'devin/devin-bbb', 'devin/devin-ccc']);
  assert.equal(records[0].reachable, true);
  assert.equal(records[0].workload, null, 'no truncation without another page');
  assert.deepEqual(records[1].workload, {
    kind: 'devin-session', id: 'devin-aaa', title: 'Fix the flaky test', state: 'running', statusDetail: 'Working on it',
    repo: null, branch: null, pullRequestUrl: 'https://github.com/o/r/pull/1', pullRequestCount: 1,
    url: 'https://app.devin.ai/sessions/devin-aaa',
    runtime: null, createdAt: iso(1760090400), updatedAt: iso(1760090700),
  });
  assert.equal(records[2].workload.pullRequestUrl, null, 'a session without PRs has no PR url');
  assert.equal(records[2].workload.pullRequestCount, 0);
  assert.equal(records[3].workload.state, 'unknown');
  assert.equal(records[3].workload.title, null);
  assert.deepEqual(calls.map((c) => c.url), [`https://api.devin.ai/v3/organizations/${ORG}/sessions?first=100`]);
  assert.match(calls[0].url, new RegExp(`/v3/organizations/${ORG}/sessions`), 'the org id is in the path');
  for (const { init } of calls) {
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(init.headers.Accept, 'application/json');
  }
});

test('devin pagination follows end_cursor while has_next_page and marks truncation on the account record', async () => {
  const many = (n, from) => Array.from({ length: n }, (_, i) => ({ session_id: `devin-${from + i}`, status: 'running', created_at: 1760090400 }));
  const calls = [];
  const records = await go(fakeFetch({
    [`/v3/organizations/${ORG}/sessions?first=5`]: { items: many(3, 0), end_cursor: 'page-2', has_next_page: true, total: 5 },
    [`/v3/organizations/${ORG}/sessions?first=2&after=page-2`]: { items: many(2, 3), end_cursor: null, has_next_page: false, total: 5 },
  }, calls), { maxAgents: 5 });
  assert.equal(records.length, 6, 'account record plus 5 sessions');
  assert.equal(records[0].workload, null, 'the last page has has_next_page false, so nothing is truncated');
  assert.deepEqual(calls.map((c) => c.url), [
    `https://api.devin.ai/v3/organizations/${ORG}/sessions?first=5`,
    `https://api.devin.ai/v3/organizations/${ORG}/sessions?first=2&after=page-2`,
  ]);
});

test('a final page with has_next_page false does not follow its end_cursor', async () => {
  const calls = [];
  const records = await go(fakeFetch({
    [`/v3/organizations/${ORG}/sessions?first=5`]: { items: [{ session_id: 'devin-a', status: 'running' }], end_cursor: 'stale', has_next_page: false, total: 1 },
    [`/v3/organizations/${ORG}/sessions`]: () => assert.fail('an end_cursor with has_next_page false must not be followed'),
  }, calls), { maxAgents: 5 });
  assert.equal(records.length, 2, 'account record plus 1 session');
  assert.equal(calls.length, 1);
  assert.equal(records[0].workload, null, 'a clean stop is not truncation');
});

test('reaching maxAgents while another page remains records truncation instead of dropping silently', async () => {
  const many = (n, from) => Array.from({ length: n }, (_, i) => ({ session_id: `devin-${from + i}`, status: 'running', created_at: 1760090400 }));
  const records = await go(fakeFetch({
    [`/v3/organizations/${ORG}/sessions?first=3`]: { items: many(3, 0), end_cursor: 'page-2', has_next_page: true, total: 9 },
    [`/v3/organizations/${ORG}/sessions`]: () => assert.fail('the cap is reached before the next page'),
  }), { maxAgents: 3 });
  assert.equal(records.length, 4, 'account record plus 3 sessions');
  assert.equal(records[0].workload.truncated, true);
  assert.match(records[0].workload.title, /more remain/);
});

// Mutation-checked: removing only the empty-page break makes a third request
// (which 404s here), so this test fails without that stop while the page cap
// stays in place.
test('an empty page stops pagination without another request', async () => {
  const calls = [];
  const records = await go(fakeFetch({
    [`/v3/organizations/${ORG}/sessions?first=5`]: { items: [{ session_id: 'devin-a', status: 'running' }, { session_id: 'devin-b', status: 'running' }], end_cursor: 'page-2', has_next_page: true, total: 5 },
    [`/v3/organizations/${ORG}/sessions?first=3&after=page-2`]: { items: [], end_cursor: null, has_next_page: false, total: 5 },
    [`/v3/organizations/${ORG}/sessions`]: () => assert.fail('an empty page must stop pagination'),
  }, calls), { maxAgents: 5 });
  assert.equal(records.length, 3, 'account record plus 2 sessions');
  assert.equal(calls.length, 2, 'far below the 1000-page cap: the stop fired, not the cap');
  assert.equal(records[0].workload, null, 'a clean stop is not truncation');
});

// Mutation-checked: removing only the repeated-cursor break makes a third
// request (which 404s here), so this test fails without that stop while the
// page cap stays in place.
test('a repeated end_cursor stops pagination instead of looping', async () => {
  const calls = [];
  const records = await go(fakeFetch({
    [`/v3/organizations/${ORG}/sessions?first=5`]: { items: [{ session_id: 'devin-a', status: 'running' }], end_cursor: 'loop', has_next_page: true, total: 9 },
    [`/v3/organizations/${ORG}/sessions?first=4&after=loop`]: { items: [{ session_id: 'devin-b', status: 'running' }], end_cursor: 'loop', has_next_page: true, total: 9 },
  }, calls), { maxAgents: 5 });
  assert.equal(records.length, 3, 'account record plus 2 sessions');
  assert.equal(calls.length, 2, 'far below the 1000-page cap: the stop fired, not the cap');
  assert.equal(records[0].workload?.truncated, true, 'more was pending, so the stop is truncation');
});

test('an oversized end_cursor ends the list as truncated', async () => {
  const calls = [];
  const records = await go(fakeFetch({
    [`/v3/organizations/${ORG}/sessions?first=5`]: { items: [{ session_id: 'devin-a', status: 'running' }], end_cursor: 'x'.repeat(1025), has_next_page: true, total: 9 },
  }, calls), { maxAgents: 5 });
  assert.equal(records.length, 2, 'account record plus 1 session');
  assert.equal(calls.length, 1, 'the oversized cursor is never followed');
  assert.equal(records[0].workload?.truncated, true);
});

test('has_next_page without an end_cursor ends the list as truncated', async () => {
  const records = await go(fakeFetch({
    [`/v3/organizations/${ORG}/sessions?first=5`]: { items: [{ session_id: 'devin-a', status: 'running' }], has_next_page: true, total: 9 },
  }), { maxAgents: 5 });
  assert.equal(records.length, 2, 'account record plus 1 session');
  assert.equal(records[0].workload?.truncated, true, 'more was pending, so the stop is truncation');
});

test('small pages with endless cursors end truncated at maxAgents, not silently short', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const n = calls.length;
    const items = [{ session_id: `devin-small-${n}-a`, status: 'running' }, { session_id: `devin-small-${n}-b`, status: 'running' }];
    return new Response(JSON.stringify({ items, end_cursor: `small-${n}`, has_next_page: true, total: 1000 }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const records = await go(fetchImpl, { maxAgents: 100 });
  assert.equal(calls.length, 50, 'two sessions per page fill 100 sessions in 50 pages');
  assert.equal(records.length, 101, 'account record plus 100 sessions');
  assert.equal(records[0].workload.truncated, true, 'a still-pending cursor means more remain');
  assert.ok(calls[0].includes('first=100'), 'pages ask for up to 200 at a time');
});

test('pagination stops at the page cap when the server always has another page', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const n = calls.length;
    const items = [{ session_id: `devin-cap-${n}`, status: 'running' }];
    return new Response(JSON.stringify({ items, end_cursor: `cap-${n}`, has_next_page: true, total: 99999 }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const records = await go(fetchImpl, { maxAgents: 1000 });
  assert.equal(calls.length, 1000, 'the fixed page bound stops an endless server');
  assert.equal(records.length, 1001, 'account record plus 1000 sessions');
  assert.equal(records[0].workload.truncated, true, 'a still-pending cursor means more remain');
});

// Mutation-checked: replacing Math.min(200, left) with just left makes the
// first request ask for first=1000, so this test fails without the page cap.
test('the first page asks for at most 200 sessions even with maxAgents=1000', async () => {
  const calls = [];
  const records = await go(fakeFetch({
    [`/v3/organizations/${ORG}/sessions?first=200`]: { items: [{ session_id: 'devin-a', status: 'running' }], end_cursor: null, has_next_page: false, total: 1 },
  }, calls), { maxAgents: 1000 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\?first=200$/, 'pages larger than 200 are never requested');
  assert.equal(records.length, 2, 'account record plus 1 session');
});

test('a page with more items than requested stays capped at maxAgents', async () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ session_id: `devin-over-${i}`, status: 'running', created_at: 1760090400 }));
  const calls = [];
  const records = await go(fakeFetch({ [`/v3/organizations/${ORG}/sessions?first=3`]: { items: many, end_cursor: null, has_next_page: false, total: 10 } }, calls), { maxAgents: 3 });
  assert.equal(records.length, 4, 'account record plus 3 sessions');
  assert.equal(records[0].workload, null, 'no has_next_page, so nothing is truncated');
  assert.equal(calls.length, 1);
});

test('untrusted session fields are sanitized before output', async () => {
  const evil = {
    session_id: '../../etc', title: 'fix\x1b]0;pwned\x07stuff', status: 'running', status_detail: '\x1b[2Jdetail',
    url: 'javascript:alert(1)', created_at: '2026-10-11T10:00:00Z', updated_at: 1.5,
    pull_requests: [{ pr_url: 'javascript:alert(2)', pr_state: 'open' }, { pr_url: 'https://github.com/o/r/pull/2', pr_state: 'open' }],
  };
  const records = await go(fakeFetch({ [`/v3/organizations/${ORG}/sessions?first=100`]: { items: [evil], end_cursor: null, has_next_page: false, total: 1 } }));
  const out = JSON.stringify(records);
  assert.doesNotMatch(out, /\x1b|javascript:/);
  assert.equal(records[1].name, 'devin/unknown', 'an unsafe id is not used in the record name');
  assert.deepEqual(records[1].workload, {
    kind: 'devin-session', id: 'unknown', title: 'fix]0;pwnedstuff', state: 'running', statusDetail: '[2Jdetail',
    repo: null, branch: null, pullRequestUrl: null, pullRequestCount: 2,
    url: null, runtime: null, createdAt: null, updatedAt: null,
  });
});

// Mutation-checked: removing the C1 range from stripControls makes this fail.
test('C1 controls and bidi/format characters are stripped from session fields', async () => {
  const tricky = String.fromCodePoint(0x85, 0x9b, 0x202e, 0x2066, 0x200b);
  const evil = {
    session_id: 'devin-ok', title: `a${tricky}b`, status: 'running', status_detail: `x${tricky}y`,
    url: `https://app.devin.ai/sessions/a${tricky}b`, created_at: 1760090400, updated_at: 1760090700,
    pull_requests: [{ pr_url: `https://github.com/o/a${tricky}b`, pr_state: 'open' }],
  };
  const records = await go(fakeFetch({ [`/v3/organizations/${ORG}/sessions?first=100`]: { items: [evil], end_cursor: null, has_next_page: false, total: 1 } }));
  const out = JSON.stringify(records);
  for (const cp of [0x85, 0x9b, 0x202e, 0x2066, 0x200b]) {
    assert.equal(out.includes(String.fromCodePoint(cp)), false, `U+${cp.toString(16)} is stripped`);
  }
  assert.equal(records[1].workload.title, 'ab');
  assert.equal(records[1].workload.statusDetail, 'xy');
  assert.equal(records[1].workload.pullRequestUrl, 'https://github.com/o/ab');
  assert.equal(records[1].workload.url, 'https://app.devin.ai/sessions/ab');
});

test('bad unix timestamps become null instead of junk dates', async () => {
  const sessions = [
    { session_id: 'devin-neg', created_at: -1, updated_at: 1.5 },
    { session_id: 'devin-huge', created_at: 4102444801, updated_at: 'tomorrow' },
    { session_id: 'devin-zero', created_at: 0, updated_at: 4102444800 },
  ];
  const records = await go(fakeFetch({ [`/v3/organizations/${ORG}/sessions?first=100`]: { items: sessions, end_cursor: null, has_next_page: false, total: 3 } }));
  assert.equal(records[1].workload.createdAt, null, 'negative seconds are nulled');
  assert.equal(records[1].workload.updatedAt, null, 'fractional seconds are nulled');
  assert.equal(records[2].workload.createdAt, null, 'seconds past the sane range are nulled');
  assert.equal(records[2].workload.updatedAt, null, 'non-integer timestamps are nulled');
  assert.equal(records[3].workload.createdAt, '1970-01-01T00:00:00.000Z');
  assert.equal(records[3].workload.updatedAt, iso(4102444800), 'the top of the sane range converts');
});

test('an absurd x-ratelimit-reset falls back instead of crashing', async () => {
  const records = await go(fakeFetch({
    [`/v3/organizations/${ORG}/sessions`]: () => new Response('{}', { status: 429, headers: { 'x-ratelimit-reset': '1e20' } }),
  }));
  assert.equal(records.length, 1);
  assert.match(records[0].error, /rate limited \(429\); try again later/);
  assert.equal(records[0].reachable, true);
});

const failures = [
  ['401', () => new Response('{"message":"Unauthorized"}', { status: 401 }), /rejected the token \(401\)/, true],
  ['403', () => new Response('{}', { status: 403 }), /forbidden \(403\).*cannot list sessions/, true],
  ['rate limit', () => new Response('{}', { status: 429, headers: { 'retry-after': '60' } }), /rate limited \(429\); retry after 60s/, true],
  ['404', () => new Response('{}', { status: 404 }), /not found \(404\).*may have changed/, true],
  ['422', () => new Response('{}', { status: 422 }), /rejected the request \(422\)/, true],
  ['500', () => new Response('{}', { status: 502 }), /API error \(502\); try again later/, true],
  ['not JSON', () => new Response('<html>', { status: 200 }), /response is not JSON/, true],
  ['wrong shape', () => new Response('[]', { status: 200 }), /unexpected response shape/, true],
  ['network', () => { throw new TypeError(`fetch failed for ${TOKEN}`); }, /unreachable: network error/, false],
  ['timeout', () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); }, /unreachable: timed out/, false],
];

for (const [label, respond, message, reached] of failures) {
  test(`a ${label} failure becomes one account record with a clean error`, async () => {
    const records = await go(fakeFetch({ [`/v3/organizations/${ORG}/sessions`]: respond }));
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

test('config: devin hosts take no target, and options are validated', () => {
  assert.equal(validateConfig({ schemaVersion: 1, hosts: [host] }).hosts[0].provider, 'devin');
  assert.throws(() => validateConfig({ schemaVersion: 1, hosts: [{ ...host, target: 'x.example' }] }), ConfigError);
  assert.throws(() => options({ apiBase: 'http://api.devin.ai' }), /https URL/);
  assert.throws(() => providerOptions('devin'), /orgId/, 'the org id is required');
  assert.throws(() => options({ orgId: '' }), /orgId/);
  assert.throws(() => options({ orgId: 'abc123' }), /orgId/, 'the org- prefix is required');
  assert.throws(() => options({ orgId: 'org-bad_chars!' }), /orgId/);
  assert.throws(() => options({ maxAgents: 0 }), /maxAgents/);
  assert.throws(() => options({ maxAgents: 1001 }), /maxAgents/);
  assert.throws(() => options({ maxAgents: '5' }), /integer/);
  assert.throws(() => options({ token: TOKEN }), /unknown key "token"/, 'the token never lives in config');
  assert.throws(() => options({ toString: 'x' }), /unknown key "toString"/, 'inherited names are not keys');
});

test('status shows Devin sessions in the same report shape and never prints the token', async (t) => {
  const { home, env } = scratchHome(t);
  writeConfig(home, { schemaVersion: 1, providers: { devin: { orgId: ORG } }, hosts: [host] });
  const fetchImpl = fakeFetch({ [`/v3/organizations/${ORG}/sessions?first=100`]: { items: [SESSIONS[0]], end_cursor: null, has_next_page: false, total: 1 } });
  const json = await run(['status', '--json'], { env, fetchImpl, tokenSource });
  const report = JSON.parse(json.out);
  assert.deepEqual(report.summary, { hosts: 2, ok: 2, drift: 0, partial: 0, unreachable: 0 });
  assert.equal(report.hosts[1].workload.branch, null);
  assert.equal(report.hosts[1].workload.pullRequestUrl, 'https://github.com/o/r/pull/1');
  assert.deepEqual(report.hosts[1].drift, []);
  const text = await run(['status'], { env, fetchImpl, tokenSource });
  assert.match(text.out, /devin\/devin-aaa \(devin\)  \[OK\]  running/);
  for (const out of [json.out, json.err, text.out, text.err]) assert.doesNotMatch(out, /TESTTOKEN/);
});
