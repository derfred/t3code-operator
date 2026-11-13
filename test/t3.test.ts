import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { settleFrame } from '../src/t3.ts';

function pendingCall() {
  const pending = new Map();
  const outcome: { value?: unknown; error?: Error } = {};
  pending.set('1', {
    resolve: (value: unknown) => (outcome.value = value),
    reject: (error: Error) => (outcome.error = error),
    timer: setTimeout(() => undefined, 0),
  });
  return { pending, outcome };
}

describe('settleFrame', () => {
  it('resolves a successful Exit with its value', () => {
    const { pending, outcome } = pendingCall();
    assert.equal(settleFrame({ _tag: 'Exit', requestId: '1', exit: { _tag: 'Success', value: { ok: 1 } } }, pending), true);
    assert.deepEqual(outcome.value, { ok: 1 });
    assert.equal(pending.size, 0);
  });

  it('rejects a failed Exit with the tagged error’s message', () => {
    const { pending, outcome } = pendingCall();
    settleFrame(
      {
        _tag: 'Exit',
        requestId: '1',
        exit: {
          _tag: 'Failure',
          cause: [{ _tag: 'Fail', error: { _tag: 'ScheduledTaskError', message: 'Schedule task not found.' } }],
        },
      },
      pending,
    );
    assert.equal(outcome.error?.message, 'Schedule task not found.');
    assert.equal((outcome.error as any).tag, 'ScheduledTaskError');
  });

  it('falls back to `detail`, as SourceControlRepositoryError carries it', () => {
    const { pending, outcome } = pendingCall();
    settleFrame(
      {
        _tag: 'Exit',
        requestId: '1',
        exit: {
          _tag: 'Failure',
          cause: [{ _tag: 'Fail', error: { _tag: 'SourceControlRepositoryError', detail: 'Destination path already exists and is not empty.' } }],
        },
      },
      pending,
    );
    assert.match(outcome.error!.message, /not empty/);
  });

  it('fails every pending call on a protocol Defect', () => {
    const { pending, outcome } = pendingCall();
    settleFrame({ _tag: 'Defect', defect: 'bad frame' }, pending);
    assert.match(outcome.error!.message, /protocol defect/);
  });

  it('ignores frames that answer nothing', () => {
    const { pending, outcome } = pendingCall();
    assert.equal(settleFrame({ _tag: 'Pong' }, pending), false);
    assert.equal(settleFrame({ _tag: 'Exit', requestId: '2', exit: { _tag: 'Success', value: 1 } }, pending), false);
    assert.equal(pending.size, 1);
    assert.deepEqual(outcome, {});
  });
});
