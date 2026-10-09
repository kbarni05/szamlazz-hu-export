const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = readFileSync(process.env.SZAMLAZZ_TEST_SOURCE || resolve(__dirname, '../szamlazz-export.user.js'), 'utf8');
const COMPANY = 'szamlazz_export_shadow_company_id';
const TOKEN = 'szamlazz_export_shadow_token';
const URL = 'https://www.szamlazz.hu/szamla/pcapi/szfej/list/';
const session = (company = 'company-old', token = 'token-old') => ({
  'shadow-login-ceg-id': company, 'shadow-login-token': token
});
const response = (status, body = '{"items":[]}', options = {}) => ({
  status, ok: status >= 200 && status < 300,
  statusText: status === 403 ? 'Forbidden' : status === 401 ? 'Unauthorized' : '',
  headers: new Headers(options.headers || {}),
  url: options.url || URL,
  redirected: Boolean(options.redirected),
  text: async () => body
});

function setup(respond = () => response(200), initialStorage = {}) {
  const storage = new Map(Object.entries(initialStorage));
  const calls = [];
  const events = [];
  class XMLHttpRequest {
    open(...args) { this.openArgs = args; }
    setRequestHeader(...args) { (this.headerArgs ||= []).push(args); }
    send(...args) { this.sendArgs = args; return 'sent'; }
  }
  const page = {
    XMLHttpRequest,
    fetch(...args) {
      assert.equal(this, page);
      calls.push(args);
      return Promise.resolve(respond(args, calls.length));
    }
  };
  const context = vm.createContext({
    unsafeWindow: page,
    window: { dispatchEvent: event => events.push(event) },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key)
    },
    CustomEvent: class { constructor(type) { this.type = type; } },
    console, setTimeout, AbortController, DOMException, Headers, URL: globalThis.URL
  });
  assert.ok(source.includes('  waitForBody();'));
  vm.runInContext(source.replace('  waitForBody();',
    '  globalThis.testApi = { postJson, normalizeHeaders, exportMode, rememberSessionHeaders, session: () => sessionHeaders };'), context);
  const seed = (company = 'company-old', token = 'token-old') => {
    context.testApi.rememberSessionHeaders(session(company, token), URL);
    events.length = 0;
  };
  return { ...context.testApi, storage, calls, events, page, seed };
}

for (const status of [401, 403]) {
  test(`${status}: retries stale headers once with browser cookies`, async () => {
    const env = setup((_, count) => response(count === 1 ? status : 200));
    env.seed();
    const signal = new AbortController().signal;
    const data = await env.postJson(URL, 'projection-value', { page: 2 }, signal);
    assert.equal(data.items.length, 0);
    assert.equal(env.calls.length, 2);
    assert.equal(env.calls[0][1].headers['shadow-login-token'], 'token-old');
    const retry = env.calls[1][1];
    assert.equal(retry.headers['shadow-login-token'], undefined);
    assert.equal(retry.headers['shadow-login-ceg-id'], undefined);
    assert.equal(retry.credentials, 'include');
    assert.equal(retry.headers.projection, 'projection-value');
    assert.equal(retry.body, '{"page":2}');
    assert.equal(retry.method, 'POST');
    assert.equal(retry.signal, signal);
    assert.equal(Boolean(env.session()['shadow-login-token']), false);
    assert.equal(env.events.length, 1);
  });
}

test('403 without cached headers is reported without retrying', async () => {
  const env = setup(() => response(403, 'permission denied'));
  await assert.rejects(env.postJson(URL, 'projection', {}, undefined), /API hiba: 403 Forbidden.*\n[\s\S]*permission denied/);
  assert.equal(env.calls.length, 1);
});

test('persistent 403 stops after one retry', async () => {
  const env = setup(() => response(403));
  env.seed();
  await assert.rejects(env.postJson(URL, 'projection', {}), /API hiba: 403/);
  assert.equal(env.calls.length, 2);
});

test('non-authentication failures do not discard the session or retry', async () => {
  const env = setup(() => response(500));
  env.seed();
  await assert.rejects(env.postJson(URL, 'projection', {}), /API hiba: 500/);
  assert.equal(env.calls.length, 1);
  assert.equal(env.session()['shadow-login-token'], 'token-old');
});

test('successful export does not announce its own headers as a new session', async () => {
  const env = setup();
  env.seed();
  await env.postJson(URL, 'projection', {});
  assert.equal(env.calls.length, 1);
  assert.equal(env.events.length, 0);
});

test('a fresh session captured while awaiting 403 is preserved for the retry', async () => {
  let env;
  env = setup((_, count) => {
    if (count === 1) {
      env.page.fetch(URL, { headers: session('company-new', 'token-new') });
      return response(403);
    }
    return response(200);
  });
  env.seed();
  await env.postJson(URL, 'projection', {});
  assert.equal(env.calls.length, 3);
  assert.equal(env.calls[2][1].headers['shadow-login-token'], 'token-new');
  assert.equal(env.session()['shadow-login-ceg-id'], 'company-new');
  assert.equal(env.session()['shadow-login-token'], 'token-new');
});

test('array headers are captured with case-insensitive names', async () => {
  const env = setup();
  await env.page.fetch(URL, { headers: [
    ['Shadow-Login-Ceg-Id', 'company-new'], ['Shadow-Login-Token', 'token-new']
  ] });
  assert.equal(env.session()['shadow-login-ceg-id'], 'company-new');
  assert.equal(env.session()['shadow-login-token'], 'token-new');
});

test('Headers objects and plain objects are supported', async () => {
  const env = setup();
  await env.page.fetch(URL, { headers: new Headers(session()) });
  assert.equal(env.session()['shadow-login-token'], 'token-old');
  await env.page.fetch(URL, { headers: session('company-new', 'token-new') });
  assert.equal(env.session()['shadow-login-token'], 'token-new');
});

test('fetch init.headers replaces Request headers rather than being overwritten', async () => {
  const env = setup();
  await env.page.fetch({ url: URL, headers: new Headers(session()) }, {
    headers: session('company-new', 'token-new')
  });
  assert.equal(env.session()['shadow-login-ceg-id'], 'company-new');
  assert.equal(env.session()['shadow-login-token'], 'token-new');
});

test('fetch uses Request headers when init.headers is omitted', async () => {
  const env = setup();
  await env.page.fetch({ url: URL, headers: new Headers(session()) });
  assert.equal(env.session()['shadow-login-token'], 'token-old');
});

test('explicit empty fetch headers do not capture unused Request headers', async () => {
  const env = setup();
  await env.page.fetch({ url: URL, headers: new Headers(session()) }, { headers: {} });
  assert.equal(Boolean(env.session()['shadow-login-token']), false);
});

test('XHR captures a complete pair only at send and resets it on open', () => {
  const env = setup();
  const xhr = new env.page.XMLHttpRequest();
  xhr.open('POST', URL, true);
  xhr.setRequestHeader('Shadow-Login-Ceg-Id', 'company-new');
  assert.equal(Boolean(env.session()['shadow-login-token']), false);
  xhr.setRequestHeader('shadow-login-token', 'token-new');
  assert.equal(Boolean(env.session()['shadow-login-token']), false);
  assert.equal(xhr.send('{}'), 'sent');
  assert.equal(env.events.length, 1);
  assert.equal(env.session()['shadow-login-ceg-id'], 'company-new');
  assert.equal(env.session()['shadow-login-token'], 'token-new');
  assert.deepEqual(xhr.openArgs, ['POST', URL, true]);
  assert.deepEqual(xhr.sendArgs, ['{}']);
  xhr.open('POST', URL);
  xhr.setRequestHeader('Shadow-Login-Ceg-Id', 'company-other');
  xhr.send();
  assert.equal(env.events.length, 1);
  assert.equal(env.session()['shadow-login-token'], 'token-new');
});

test('aborted retry propagates AbortError and is not retried again', async () => {
  const controller = new AbortController();
  const env = setup((_, count) => {
    if (count === 1) { controller.abort(); return response(403); }
    throw new DOMException('Megszakítva', 'AbortError');
  });
  env.seed();
  await assert.rejects(env.postJson(URL, 'projection', {}, controller.signal), { name: 'AbortError' });
  assert.equal(env.calls.length, 2);
  assert.equal(env.calls[1][1].signal, controller.signal);
});

test('invalid JSON and network errors remain visible', async () => {
  const env = setup(() => response(200, '<html>login</html>'));
  await assert.rejects(env.postJson(URL, 'projection', {}), /JSON helyett HTML-oldalt/);
  const offline = setup(() => { throw new TypeError('Network failure'); });
  offline.seed();
  await assert.rejects(offline.postJson(URL, 'projection', {}), /Network failure/);
  assert.equal(offline.calls.length, 1);
  assert.equal(offline.session()['shadow-login-token'], 'token-old');
});

test('export preserves fetch wrappers installed later by the page', async () => {
  const env = setup();
  const previousFetch = env.page.fetch;
  let wrapperCalls = 0;
  env.page.fetch = function () {
    wrapperCalls++;
    return previousFetch.apply(this, arguments);
  };
  env.seed();
  await env.postJson(URL, 'projection', {});
  assert.equal(wrapperCalls, 1);
  assert.equal(env.events.length, 0);
});

for (const mode of ['invoice', 'receipt']) {
  test(`${mode}: CEG_MISMATCH recovers and exports the actual list`, async () => {
    const error = JSON.stringify({ errors: [{
      prohibitor: { name: 'CEG_MISMATCH' }, code: 'XHB_0001',
      message: 'Úgy tűnik, fiókot váltottál…', type: 'FORBIDDEN'
    }] });
    const head = mode === 'invoice'
      ? { szfej: { szlasz: 'INVOICE-1', keltDat: '2026-10-09' } }
      : { nyfej: { nyugtaszam: 'RECEIPT-1', keltDat: '2026-10-09' } };
    const env = setup((_, count) => count === 1 ? response(403, error) : response(200,
      JSON.stringify({ items: [head], hasNextPage: false, totalSize: 1 })));
    env.seed();
    const result = await env.exportMode(mode, {}, null, 'integer', 'issue', 'desc',
      () => {}, new AbortController().signal);
    assert.equal(result.fetchedCount, 1);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].number, mode === 'invoice' ? 'INVOICE-1' : 'RECEIPT-1');
    assert.equal(env.calls.length, 2);
    assert.equal(env.calls[1][0], mode === 'invoice' ? URL
      : 'https://www.szamlazz.hu/szamla/pcapi/nyfej/list/all');
    const body = JSON.parse(env.calls[1][1].body);
    assert.equal(body.page, 0);
    assert.equal(body.pageSize, 50);
    if (mode === 'invoice') assert.equal(body.kimeno, true);
    else assert.equal(body.searchKey, '');
    const projection = JSON.parse(env.calls[1][1].headers.projection);
    assert.equal(projection.items[mode === 'invoice' ? 'szfej' : 'nyfej'],
      mode === 'invoice' ? 'szfejkimenolist' : 'list');
  });
}

for (const prefix of ["\uFEFF", ")]}'\n", ")]}',\n", ")]}'\r\n"]) {
  test(`parses JSON with a standard BOM/XSSI prefix ${JSON.stringify(prefix)}`, async () => {
    const env = setup(() => response(200, prefix + '{"items":[{"id":1}]}'));
    const data = await env.postJson(URL, 'projection', {});
    assert.equal(data.items[0].id, 1);
    assert.equal(env.calls.length, 1);
  });
}

test('BOM, whitespace and XSSI prefix can appear together', async () => {
  const env = setup(() => response(200, "\uFEFF  \n)]}',\n{\"items\":[]}"));
  assert.equal((await env.postJson(URL, 'projection', {})).items.length, 0);
});

test('previous page company and token are removed and never sent', async () => {
  const env = setup(undefined, { [COMPANY]: 'old-page-company', [TOKEN]: 'old-page-token' });
  assert.equal(env.storage.has(COMPANY), false);
  assert.equal(env.storage.has(TOKEN), false);
  await env.postJson(URL, 'projection', {});
  assert.equal(env.calls[0][1].headers['shadow-login-token'], undefined);
});

test('HTML with a stale observed pair retries once and handles prefixed JSON', async () => {
  const env = setup((_, count) => count === 1
    ? response(200, '<!doctype html><html>Login</html>', {
      headers: { 'content-type': 'text/html; charset=UTF-8' }, redirected: true
    }) : response(200, ")]}',\n{\"items\":[]}"));
  env.seed();
  assert.equal((await env.postJson(URL, 'projection', {})).items.length, 0);
  assert.equal(env.calls.length, 2);
  assert.equal(env.calls[1][1].headers['shadow-login-token'], undefined);
});

test('persistent HTML produces safe diagnostics instead of accepting a list', async () => {
  const env = setup(() => response(200, '<html>private secret-in-body</html>', {
    headers: { 'content-type': 'text/html; charset=UTF-8' },
    url: 'https://www.szamlazz.hu/szamla/login?token=secret-in-query', redirected: true
  }));
  env.seed();
  await assert.rejects(env.postJson(URL, 'projection', {}), error => {
    assert.match(error.message, /JSON helyett HTML-oldalt/);
    assert.match(error.message, /HTTP: 200; típus: text\/html; átirányítás: igen; útvonal: \/szamla\/login/);
    assert.equal(error.message.includes('secret-in-body'), false);
    assert.equal(error.message.includes('secret-in-query'), false);
    return true;
  });
  assert.equal(env.calls.length, 2);
});

test('HTML without an observed pair is not retried', async () => {
  const env = setup(() => response(200, '<html>Login</html>'));
  await assert.rejects(env.postJson(URL, 'projection', {}), /HTML-oldalt/);
  assert.equal(env.calls.length, 1);
});

test('empty and malformed replies are distinguished without leaking response text', async () => {
  const empty = setup(() => response(200, ''));
  await assert.rejects(empty.postJson(URL, 'projection', {}), /üres választ/);
  const invalid = setup(() => response(200, 'private arbitrary text'));
  await assert.rejects(invalid.postJson(URL, 'projection', {}), error => {
    assert.match(error.message, /nem értelmezhető szöveget/);
    assert.equal(error.message.includes('private arbitrary text'), false);
    return true;
  });
});

for (const mode of ['invoice', 'receipt']) {
  test(`${mode}: export uses the exact list path observed on the page`, async () => {
    const env = setup();
    const path = mode === 'invoice' ? '/app/pcapi/szfej/list/' : '/app/pcapi/nyfej/list/all';
    const observedUrl = 'https://www.szamlazz.hu' + path;
    await env.page.fetch(observedUrl, { headers: {
      ...session(), 'X-XSRF-TOKEN': 'current-csrf', authorization: 'Bearer test-only',
      projection: 'native-projection', 'irrelevant-header': 'ignore-me'
    } });
    const requestedUrl = mode === 'invoice' ? URL
      : 'https://www.szamlazz.hu/szamla/pcapi/nyfej/list/all';
    await env.postJson(requestedUrl, 'export-projection', {});
    assert.equal(env.calls[1][0], observedUrl);
    assert.equal(env.calls[1][1].headers['x-xsrf-token'], 'current-csrf');
    assert.equal(env.calls[1][1].headers.authorization, 'Bearer test-only');
    assert.equal(env.calls[1][1].headers.projection, 'export-projection');
    assert.equal(env.calls[1][1].headers['irrelevant-header'], undefined);
  });
}

test('third-party and non-API requests cannot replace the current session or target', async () => {
  const env = setup();
  env.seed();
  await env.page.fetch('https://example.org/pcapi/szfej/list/', { headers: session('foreign', 'foreign') });
  await env.page.fetch('https://www.szamlazz.hu/other', { headers: session('wrong', 'wrong') });
  await env.postJson(URL, 'projection', {});
  assert.equal(env.calls[2][0], URL);
  assert.equal(env.calls[2][1].headers['shadow-login-token'], 'token-old');
});

test('a cookie-only native list request clears the previous shadow pair', async () => {
  const env = setup();
  env.seed();
  await env.page.fetch(URL, { headers: { 'x-csrf-token': 'fresh-cookie-csrf' } });
  await env.postJson(URL, 'projection', {});
  assert.equal(env.calls[1][1].headers['shadow-login-token'], undefined);
  assert.equal(env.calls[1][1].headers['x-csrf-token'], 'fresh-cookie-csrf');
});

test('a refreshed CSRF token with the same company pair is preserved after 403', async () => {
  let env;
  env = setup((_, count) => {
    if (count === 1) {
      env.rememberSessionHeaders({ ...session(), 'x-csrf-token': 'refreshed' }, URL);
      return response(403);
    }
    return response(200);
  });
  env.seed();
  await env.postJson(URL, 'projection', {});
  assert.equal(env.calls[1][1].headers['x-csrf-token'], 'refreshed');
  assert.equal(env.calls[1][1].headers['shadow-login-token'], 'token-old');
});

test('valid JSON without a list is an error rather than an empty export', async () => {
  const env = setup(() => response(200, '{"loginRequired":true}'));
  await assert.rejects(env.exportMode('invoice', {}, null, 'integer', 'issue', 'desc',
    () => {}, new AbortController().signal), /nem tartalmaz számla- vagy nyugtalistát/);
});
