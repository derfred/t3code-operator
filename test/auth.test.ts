import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileCredentials, parseTtl, SESSION_SCOPES, SESSION_SUBJECT, Sessions } from '../src/auth.ts';

describe('parseTtl', () => {
  it('reads a number and a unit', () => {
    assert.equal(parseTtl('90s'), 90_000);
    assert.equal(parseTtl('15m'), 900_000);
    assert.equal(parseTtl('1h'), 3_600_000);
    assert.equal(parseTtl('7d'), 7 * 86_400_000);
  });
  it('refuses anything else', () => {
    for (const bad of ['', '7', 'd', '0d', '1.5h', '7 days', '1w']) assert.throws(() => parseTtl(bad), /auth\.ttl/);
  });
});

describe('fileCredentials', () => {
  it('reads the StatefulSet’s file once, and again on refresh', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auth-test-'));
    try {
      writeFileSync(join(dir, 'team'), 'first\n');
      const creds = fileCredentials(dir, 'team');
      assert.equal(await creds.token(), 'first');
      writeFileSync(join(dir, 'team'), 'second\n');
      assert.equal(await creds.token(), 'first', 'cached within the pass');
      assert.equal(await creds.refresh(), 'second');
      assert.equal(await creds.token(), 'second');
      await assert.rejects(fileCredentials(dir, 'other').token(), /no API token for StatefulSet other/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A t3 container's `t3 auth session` as far as the operator uses it.
function fakeT3() {
  const calls: Array<{ pod: string; container: string; command: ReadonlyArray<string> }> = [];
  let sessions: Array<{ sessionId: string; subject: string }> = [{ sessionId: 'theirs', subject: 'someone' }];
  let next = 0;
  let failIssue: string | undefined;
  const exec = async (pod: string, container: string, command: ReadonlyArray<string>) => {
    calls.push({ pod, container, command });
    const [, , , verb, ...rest] = command;
    if (verb === 'issue') {
      if (failIssue) throw new Error(failIssue);
      const ttl = rest[rest.indexOf('--ttl') + 1]!;
      const id = `s${++next}`;
      sessions.push({ sessionId: id, subject: rest[rest.indexOf('--subject') + 1]! });
      return JSON.stringify({ sessionId: id, token: `token-${id}`, expiresAt: new Date(clock + parseTtl(ttl)).toISOString() });
    }
    if (verb === 'list') return JSON.stringify(sessions);
    if (verb === 'revoke') {
      sessions = sessions.filter((s) => s.sessionId !== rest[0]);
      return '';
    }
    throw new Error(`unexpected ${command.join(' ')}`);
  };
  let clock = Date.parse('2026-11-17T00:00:00Z');
  return {
    calls,
    exec,
    sessions: () => sessions,
    now: () => new Date(clock),
    advance: (ms: number) => (clock += ms),
    failIssue: (message: string | undefined) => (failIssue = message),
  };
}

const pod = { name: 't3-0', uid: 'uid-1' };
const issues = (calls: ReturnType<typeof fakeT3>['calls']) => calls.filter((c) => c.command[3] === 'issue');

describe('Sessions', () => {
  it('issues a scoped token in the pod’s container, and revokes the operator’s earlier ones only', async () => {
    const t3 = fakeT3();
    const sessions = new Sessions(t3.exec, t3.now);
    // One left by an operator before a restart.
    t3.sessions().push({ sessionId: 'stale', subject: SESSION_SUBJECT });
    const token = await sessions.credentials(pod, { mode: 'Session', container: 'main', ttl: '1h' }).token();
    assert.equal(token, 'token-s1');
    const [issue] = issues(t3.calls);
    assert.equal(issue!.pod, 't3-0');
    assert.equal(issue!.container, 'main');
    assert.deepEqual(issue!.command, [
      't3', 'auth', 'session', 'issue', '--json', '--subject', SESSION_SUBJECT, '--label', SESSION_SUBJECT, '--ttl', '1h',
      ...SESSION_SCOPES.flatMap((s) => ['--scope', s]),
    ]);
    assert.deepEqual(t3.sessions().map((s) => s.sessionId), ['theirs', 's1']);
  });

  it('defaults to container t3 and 7d', async () => {
    const t3 = fakeT3();
    await new Sessions(t3.exec, t3.now).credentials(pod, { mode: 'Session' }).token();
    const [issue] = issues(t3.calls);
    assert.equal(issue!.container, 't3');
    assert.equal(issue!.command[issue!.command.indexOf('--ttl') + 1], '7d');
  });

  it('keeps a token until half its life is gone', async () => {
    const t3 = fakeT3();
    const sessions = new Sessions(t3.exec, t3.now);
    const creds = () => sessions.credentials(pod, { mode: 'Session', ttl: '2h' });
    assert.equal(await creds().token(), 'token-s1');
    t3.advance(59 * 60_000);
    assert.equal(await creds().token(), 'token-s1');
    t3.advance(2 * 60_000);
    assert.equal(await creds().token(), 'token-s2');
    assert.equal(issues(t3.calls).length, 2);
    assert.deepEqual(t3.sessions().map((s) => s.sessionId), ['theirs', 's2']);
  });

  it('issues again for a recreated pod, or a changed ttl', async () => {
    const t3 = fakeT3();
    const sessions = new Sessions(t3.exec, t3.now);
    assert.equal(await sessions.credentials(pod, { ttl: '1h' }).token(), 'token-s1');
    assert.equal(await sessions.credentials({ ...pod, uid: 'uid-2' }, { ttl: '1h' }).token(), 'token-s2');
    assert.equal(await sessions.credentials({ ...pod, uid: 'uid-2' }, { ttl: '2h' }).token(), 'token-s3');
  });

  it('issues again after a 401, but not for a token it has only just issued', async () => {
    const t3 = fakeT3();
    const sessions = new Sessions(t3.exec, t3.now);
    const creds = sessions.credentials(pod, {});
    assert.equal(await creds.token(), 'token-s1');
    assert.equal(await creds.refresh(), 'token-s1', 'a fresh token refused: no exec storm');
    t3.advance(61_000);
    assert.equal(await creds.refresh(), 'token-s2');
  });

  it('issues once for concurrent callers', async () => {
    const t3 = fakeT3();
    const sessions = new Sessions(t3.exec, t3.now);
    const tokens = await Promise.all([1, 2, 3].map(() => sessions.credentials(pod, {}).token()));
    assert.deepEqual(tokens, ['token-s1', 'token-s1', 'token-s1']);
    assert.equal(issues(t3.calls).length, 1);
  });

  it('forgets pods that are gone', async () => {
    const t3 = fakeT3();
    const sessions = new Sessions(t3.exec, t3.now);
    await sessions.credentials(pod, {}).token();
    sessions.retain(new Set(['t3-1']));
    assert.equal(await sessions.credentials(pod, {}).token(), 'token-s2');
  });

  it('names the pod and container when issuing fails, and tries again next time', async () => {
    const t3 = fakeT3();
    const sessions = new Sessions(t3.exec, t3.now);
    t3.failIssue('pods "t3-0" is forbidden');
    await assert.rejects(sessions.credentials(pod, {}).token(), /issuing a session token in t3-0\/t3: pods "t3-0" is forbidden/);
    t3.failIssue(undefined);
    assert.equal(await sessions.credentials(pod, {}).token(), 'token-s1');
  });

  it('keeps the new token when revoking the earlier ones fails', async () => {
    const t3 = fakeT3();
    const logged: string[] = [];
    const exec = async (p: string, c: string, command: ReadonlyArray<string>) => {
      if (command[3] === 'list') throw new Error('list failed');
      return t3.exec(p, c, command);
    };
    const sessions = new Sessions(exec, t3.now, (message) => logged.push(message));
    assert.equal(await sessions.credentials(pod, {}).token(), 'token-s1');
    assert.ok(logged.includes('revoking earlier session tokens failed'));
  });
});
