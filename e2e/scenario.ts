// The end-to-end scenario. It drives the operator only through the (fake)
// Kubernetes API, as kubectl would, and checks the results in t3 itself.
// Watch-driven reactions are timed against bounds far below the operator's
// resync interval, so a passing run shows the watches work.

import assert from 'node:assert/strict';
import type { FakeApiServer } from './fake-apiserver.ts';
import type { T3 } from '../src/t3.ts';

export const NAMESPACE = 't3code';
// The scenario's StatefulSet; the operator finds its token under this name.
export const STATEFUL_SET = 't3-e2e';
const pods = `/api/v1/namespaces/${NAMESPACE}/pods`;
const statefulSets = `/apis/apps/v1/namespaces/${NAMESPACE}/statefulsets`;
const sets = `/apis/t3code.derfred.com/v1alpha1/namespaces/${NAMESPACE}/t3environmentsets`;
const projects = `/apis/t3code.derfred.com/v1alpha1/namespaces/${NAMESPACE}/t3projects`;
const GATE = 't3code.derfred.com/content-ready';

export interface Context {
  readonly api: FakeApiServer;
  // A client for the t3 under test, to check results with.
  readonly t3: T3;
  readonly podIP: string;
  // A repository t3 can clone, and a directory it can clone into.
  readonly remote: string;
  readonly workspace: string;
}

const step = (message: string) => console.log(`e2e: ${message}`);

async function until<T>(what: string, timeoutMs: number, probe: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined && value !== false) return value as T;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}${last ? `: ${last}` : ''}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const overrideOf = async (t3: T3, projectId: string) =>
  ((await t3.call('server.getConfig', {})) as any).settings.projectSettingsOverrides[projectId];

export async function run({ api, t3, podIP, remote, workspace }: Context): Promise<void> {
  // What a StatefulSet with one replica would have made.
  api.create(statefulSets, {
    metadata: { name: STATEFUL_SET },
    spec: { selector: { matchLabels: { app: 't3', set: 'e2e' } } },
  });
  api.create(pods, {
    metadata: { name: 't3-e2e-0', labels: { app: 't3', set: 'e2e' } },
    spec: { readinessGates: [{ conditionType: GATE }] },
    status: { podIP, conditions: [{ type: 'ContainersReady', status: 'True' }] },
  });
  api.create(sets, { metadata: { name: 'e2e', labels: { trust: 'test' } }, spec: { statefulSet: STATEFUL_SET } });
  const gate = () => api.get(pods, 't3-e2e-0')?.status?.conditions?.find((c: any) => c.type === GATE)?.status;

  api.create(projects, {
    metadata: { name: 'e2e' },
    spec: {
      repository: remote,
      path: `${workspace}/e2e`,
      environmentSetSelector: { matchLabels: { trust: 'test' } },
      project: { pinned: true },
      settings: { branchNamePrefix: 'e2e/' },
      tasks: {
        hello: {
          prompt: 'Say hello.',
          // Never fires during the run: disabled, at a fixed time.
          enabled: false,
          schedule: { type: 'fixed_time', timeOfDay: '03:00' },
          modelSelection: { instanceId: 'codex', model: 'gpt-5.4-mini' },
          runtimeMode: 'approval-required',
        },
      },
    },
  });
  step('created a T3EnvironmentSet, its StatefulSet and pod, and a T3Project');

  await until('the finalizer', 15_000, () => api.get(projects, 'e2e')?.metadata.finalizers?.includes('t3code.derfred.com/cleanup'));
  // The gate is closed while the clone runs, or opens straight away if it
  // was quick; it must not open before the project is Ready.
  const project = await until('the project to be Ready', 120_000, () => {
    const p = api.get(projects, 'e2e');
    return p?.status?.phase === 'Ready' ? p : undefined;
  });
  assert.deepEqual(project.status.environments.map((e: any) => [e.name, e.environmentSet, e.projectId]), [['t3-e2e-0', 'e2e', 'k8s-e2e']]);
  step('project Ready');

  await until('the content gate to open', 15_000, () => gate() === 'True');
  await until('the T3EnvironmentSet to be Ready', 15_000, () => api.get(sets, 'e2e')?.status?.phase === 'Ready');
  step('content gate open, T3EnvironmentSet Ready');

  const inT3 = (await t3.listProjects()).find((p) => p.id === 'k8s-e2e') as any;
  assert.ok(inT3, 'project k8s-e2e exists in t3');
  assert.equal(inT3.workspaceRoot, `${workspace}/e2e`);
  assert.ok(inT3.pinnedAt, 'spec.project was applied (pinned)');
  assert.deepEqual(await overrideOf(t3, 'k8s-e2e'), { branchNamePrefix: 'e2e/' });
  await until('the task to be placed', 15_000, () => {
    const tasks = api.get(projects, 'e2e')?.status?.tasks ?? [];
    return tasks.length === 1 && tasks[0].name === 'hello' && JSON.stringify(tasks[0].environments) === '["t3-e2e-0"]';
  });
  step('project fields, overrides and the task are in t3');

  // Settled: the operator's own writes come back to it through its watches,
  // and must not lead to more writes.
  const writes = () => api.requests.filter((r) => r.method === 'PATCH').length;
  const before = writes();
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.equal(writes(), before, 'a settled operator writes nothing');
  step('settled: no writes while nothing changes');

  // A spec change reaches t3 through the watch, long before any resync.
  api.patch(projects, 'e2e', { spec: { settings: { branchNamePrefix: 'changed/' } } });
  const started = Date.now();
  await until('the changed override in t3', 10_000, async () => (await overrideOf(t3, 'k8s-e2e'))?.branchNamePrefix === 'changed/');
  step(`a spec change reached t3 in ${Date.now() - started}ms`);

  // A repository git can't clone: t3 reports the failure (read from its
  // clone stream), and the project turns Error without holding the gate.
  // Fixing the URL starts it over under a fresh id: t3 never takes the
  // deleted one again.
  api.create(projects, {
    metadata: { name: 'fixme' },
    spec: {
      repository: `${remote}-missing`,
      path: `${workspace}/fixme`,
      environmentSetSelector: { matchLabels: { trust: 'test' } },
      deletionPolicy: 'Delete',
    },
  });
  const failed = await until('the failed clone to be Error', 30_000, () => {
    const env = api.get(projects, 'fixme')?.status?.environments?.[0];
    return env?.phase === 'Error' ? env : undefined;
  });
  assert.match(failed.message, /^clone of .*-missing failed: /);
  assert.equal(gate(), 'True', 'an Error does not hold the gate');
  step(`a failed clone is Error: ${failed.message}`);

  api.patch(projects, 'fixme', { spec: { repository: remote } });
  const fixed = await until('the fixed project to be Ready', 60_000, () => {
    const env = api.get(projects, 'fixme')?.status?.environments?.[0];
    return env?.phase === 'Ready' ? env : undefined;
  });
  assert.match(fixed.projectId, /^k8s-fixme-[0-9a-f]{8}$/);
  const live = (await t3.listProjects()).filter((p) => p.workspaceRoot === `${workspace}/fixme` && p.deletedAt === null);
  assert.deepEqual(live.map((p) => p.id), [fixed.projectId], 'one project at the path: the failed one went');
  step(`fixing the repository cloned it as ${fixed.projectId}`);

  api.delete(projects, 'fixme');
  await until('the fixme T3Project to be gone', 30_000, () => api.get(projects, 'fixme') === undefined);

  api.delete(projects, 'e2e');
  await until('the T3Project to be gone', 30_000, () => api.get(projects, 'e2e') === undefined);
  const archived = (await t3.listProjects()).find((p) => p.id === 'k8s-e2e');
  assert.ok(archived?.archivedAt, 'project archived on deletion');
  assert.equal(await overrideOf(t3, 'k8s-e2e'), undefined, 'overrides cleared on deletion');
  step('deleting the T3Project archived it in t3, cleared its overrides, and released the finalizer');
}
