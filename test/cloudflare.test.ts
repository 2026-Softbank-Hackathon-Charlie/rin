import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiUrl, graphqlRefusal } from '../src/cloudflare/api.js';

test('apiUrl keeps requests under the v4 API', () => {
  const url = apiUrl('/zones/abc/dns_records', { per_page: '100', type: 'CNAME' });
  assert.ok(url instanceof URL);
  assert.equal(url.href, 'https://api.cloudflare.com/client/v4/zones/abc/dns_records?per_page=100&type=CNAME');
  assert.equal((apiUrl('client/v4/zones') as URL).pathname, '/client/v4/zones');
  assert.equal((apiUrl('//evil.example/x') as URL).origin, 'https://api.cloudflare.com');
});

test('apiUrl refuses paths that leave the API or smuggle a query', () => {
  for (const path of ['', '../user', 'zones/%2e%2e/%2e%2e/x', 'https://evil.example/zones', 'zones?per_page=5', 'zones#x', 'zones\\..\\x']) {
    assert.equal(typeof apiUrl(path), 'string', path);
  }
});

test('graphqlRefusal blocks mutations only', () => {
  assert.equal(graphqlRefusal('{ viewer { zones { httpRequests1dGroups(limit: 1) { sum { requests } } } } }'), undefined);
  assert.ok(graphqlRefusal('mutation { x }'));
  assert.ok(graphqlRefusal('  Mutation Foo { x }'));
});
