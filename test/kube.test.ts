import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execOutcome } from '../src/kube.ts';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('execOutcome', () => {
  it('is stdout, joined across messages, when the Status is Success', () => {
    const channels = new Map([
      [1, [bytes('{"tok'), bytes('en":1}')]],
      [3, [bytes('{"metadata":{},"status":"Success"}')]],
    ]);
    assert.deepEqual(execOutcome(channels), { ok: true, stdout: '{"token":1}' });
  });

  it('is the Status message and stderr on failure', () => {
    const channels = new Map([
      [2, [bytes('error: unknown flag --subject\n')]],
      [3, [bytes(JSON.stringify({ status: 'Failure', reason: 'NonZeroExitCode', message: 'command terminated with non-zero exit code: exit code 1' }))]],
    ]);
    assert.deepEqual(execOutcome(channels), {
      ok: false,
      error: 'command terminated with non-zero exit code: exit code 1: error: unknown flag --subject',
    });
  });

  it('fails without a Status', () => {
    assert.deepEqual(execOutcome(new Map([[1, [bytes('partial')]]])), { ok: false, error: 'the connection closed without an exit status' });
  });
});
