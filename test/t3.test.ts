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
  it('settles a stream call with the first value of its first Chunk', () => {
    const { pending, outcome } = pendingCall();
    assert.equal(settleFrame({ _tag: 'Chunk', requestId: '1', values: [[{ projectId: 'p' }], [{ projectId: 'q' }]] }, pending), true);
    assert.deepEqual(outcome.value, [{ projectId: 'p' }]);
    assert.equal(pending.size, 0);
    // The stream's Exit, after the interrupt, answers nothing.
    assert.equal(settleFrame({ _tag: 'Exit', requestId: '1', exit: { _tag: 'Success', value: null } }, pending), false);
  });

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

describe('makeT3 credentials', () => {
  it('refreshes the token once after a 401, and keeps the fresh one', async () => {
    const { createServer } = await import('node:http');
    const { makeT3 } = await import('../src/t3.ts');
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(String(req.headers.authorization));
      const ok = req.headers.authorization === 'Bearer fresh';
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      res.end(ok ? JSON.stringify({ projects: [] }) : '{"error":"unauthorized"}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      let current = 'stale';
      let refreshes = 0;
      const client = makeT3(`http://127.0.0.1:${(server.address() as any).port}`, {
        token: async () => current,
        refresh: async () => {
          refreshes++;
          return (current = 'fresh');
        },
      });
      assert.deepEqual(await client.listProjects(), []);
      assert.deepEqual(await client.listProjects(), []);
      assert.deepEqual(seen, ['Bearer stale', 'Bearer fresh', 'Bearer fresh']);
      assert.equal(refreshes, 1);

      // Refused again after the refresh: an error, not a loop.
      current = 'stale';
      const refused = makeT3(`http://127.0.0.1:${(server.address() as any).port}`, { token: async () => 'bad', refresh: async () => 'worse' });
      await assert.rejects(refused.listProjects(), /HTTP 401/);
    } finally {
      server.close();
    }
  });
});
