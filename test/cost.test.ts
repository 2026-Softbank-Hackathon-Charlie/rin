import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCost } from '../src/worker/cost.js';

test('a resumed session reports only what this run spent', () => {
  assert.ok(Math.abs(runCost(0.82, 0.74)! - 0.08) < 1e-9);
});

test('a new session reports its whole total', () => {
  assert.equal(runCost(0.3, 0), 0.3);
});

test('a total below the recorded one means the session started over', () => {
  assert.equal(runCost(0.1, 0.9), 0.1);
});

test('no result means no cost', () => {
  assert.equal(runCost(null, 0.5), null);
});
