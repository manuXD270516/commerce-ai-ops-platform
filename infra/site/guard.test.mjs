// node --test infra/site/guard.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findPrivateData } from './guard.mjs';

test('flags every kind of private data', () => {
  assert.deepEqual(findPrivateData('D:\\projects\\x'), ['Windows path']);
  assert.deepEqual(findPrivateData('/home/runner/work/x'), ['local path']);
  assert.deepEqual(findPrivateData('postgres://u:p@host/db'), ['connection string']);
  assert.deepEqual(findPrivateData('Authorization: Bearer abc.def.ghi'), ['bearer token']);
  assert.deepEqual(findPrivateData('{"kty":"EC","d":"secret"}'), ['private JWK']);
  assert.deepEqual(findPrivateData('-----BEGIN EC PRIVATE KEY-----'), ['private key']);
  assert.deepEqual(findPrivateData('write to ana@example.com'), ['email address']);
});

test('accepts the kind of content the site publishes', () => {
  assert.deepEqual(
    findPrivateData('<td>intent_routing_macro_f1</td><td>0.936</td> https://github.com/x/y'),
    [],
  );
});
