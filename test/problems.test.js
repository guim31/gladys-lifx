// -----------------------------------------------------------------------------
// ProblemLog: one line when a failure starts or changes, one when it ends.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProblemLog } from '../src/problems.js';

function recorder() {
  const lines = [];
  const log = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (message) => lines.push([level, message]),
    ]),
  );
  return { lines, log, above: () => lines.filter(([level]) => level !== 'debug') };
}

test('a repeated failure is logged once, then at debug level', () => {
  const { log, above } = recorder();
  const problems = new ProblemLog(log);
  assert.equal(problems.fail('read', 'Cannot read'), true);
  assert.equal(problems.fail('read', 'Cannot read'), false);
  assert.equal(problems.fail('read', 'Cannot read'), false);
  assert.deepEqual(above(), [['warn', 'Cannot read']]);
});

test('a new message is logged again, other keys are independent', () => {
  const { log, above } = recorder();
  const problems = new ProblemLog(log);
  problems.fail('a', 'first');
  problems.fail('a', 'second', 'error');
  problems.fail('b', 'first');
  assert.deepEqual(above(), [
    ['warn', 'first'],
    ['error', 'second'],
    ['warn', 'first'],
  ]);
});

test('the end of a logged problem is said once; an unknown key says nothing', () => {
  const { log, above } = recorder();
  const problems = new ProblemLog(log);
  assert.equal(problems.recover('read', 'back'), false);
  problems.fail('read', 'Cannot read');
  assert.equal(problems.recover('read', 'back'), true);
  assert.equal(problems.recover('read', 'back'), false);
  assert.deepEqual(above(), [
    ['warn', 'Cannot read'],
    ['info', 'back'],
  ]);
  // Logged again once it fails again.
  assert.equal(problems.fail('read', 'Cannot read'), true);
});

test('a problem kept at debug level ends at debug level', () => {
  const { log, above, lines } = recorder();
  const problems = new ProblemLog(log);
  assert.equal(problems.fail('scan', 'busy', 'debug'), false);
  assert.equal(problems.recover('scan', 'back'), true);
  assert.deepEqual(above(), []);
  assert.equal(lines.length, 2);
});
