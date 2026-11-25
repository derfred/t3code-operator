import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Environment } from '../src/kube.ts';
import { FINALIZER, reconcileEnvironmentSet, World, type PlacedSet } from '../src/reconcile.ts';
import type { T3 } from '../src/t3.ts';
import {
  reconcileWorkflow,
  WorkflowHosts,
  workflowFileFor,
  type WorkflowResource,
  type WorkflowSpec,
} from '../src/workflows.ts';

// ─── fakes ───────────────────────────────────────────────────────────────────

const OFF = 'Workflows are off on this server.';

// t3's workflow definitions as t3 0.1.12 answers for them: nothing listed or
// saved while workflows are off; a file that doesn't load, or that drops a
// version with runs still open, refused and left as it was.
class FakeT3 implements T3 {
  enabled = false;
  single = false;
  files = new Map<string, string>();
  runs: Array<{ runId: string; workflow: string; version: number; status: string }> = [];
  questions: Array<{ runId: string; name: string }> = [];
  calls: Array<{ method: string; payload: any }> = [];

  async listProjects() {
    return [];
  }
  async mutateProject() {}
  defines(source: string) {
    return [...source.matchAll(/workflow\("([\w-]+)", \{ version: (\d+)/g)].map((m) => `${m[1]}@${m[2]}`);
  }
  // A version that a change would drop while runs of it are open.
  stranded(before: string | undefined, after: string | undefined) {
    const kept = new Set(after === undefined ? [] : this.defines(after));
    for (const version of before === undefined ? [] : this.defines(before)) {
      if (kept.has(version)) continue;
      const [workflow, v] = version.split('@');
      const open = this.runs.filter((r) => r.workflow === workflow && r.version === Number(v) && ['running', 'waiting', 'paused'].includes(r.status));
      if (open.length > 0) return `${version} is no longer defined, and ${open.length} of its runs has not ended.`;
    }
    return undefined;
  }
  async call(method: string, payload: any): Promise<any> {
    this.calls.push({ method, payload });
    switch (method) {
      case 'server.getConfig':
        return { settings: { workflowsEnabled: this.enabled } };
      case 'server.updateSettings':
        if ('workflowsEnabled' in payload.patch) this.enabled = payload.patch.workflowsEnabled;
        return {};
      case 'workflows.getDefinition':
        if (!this.enabled) return { directory: '/w', single: this.single, files: [], problems: [{ message: OFF }] };
        return {
          directory: '/w',
          single: this.single,
          files: [...this.files].map(([name, source]) => ({ name, source, workflows: this.defines(source), problems: [] })),
          problems: [],
        };
      case 'workflows.saveDefinition': {
        if (!this.enabled) return { changed: false, problems: [{ message: OFF }] };
        if (payload.source.includes('BROKEN')) {
          return { changed: false, problems: [{ message: 'Expression expected', file: payload.name, line: 1 }] };
        }
        const stranded = this.stranded(this.files.get(payload.name), payload.source);
        if (stranded) return { changed: false, problems: [{ message: stranded }] };
        this.files.set(payload.name, payload.source);
        return { changed: true, problems: [] };
      }
      case 'workflows.deleteDefinition': {
        if (!this.enabled) return { changed: false, problems: [{ message: OFF }] };
        if (!this.files.has(payload.name)) return { changed: false, problems: [{ message: `Could not delete ${payload.name}: NotFound` }] };
        const stranded = this.stranded(this.files.get(payload.name), undefined);
        if (stranded) return { changed: false, problems: [{ message: stranded }] };
        this.files.delete(payload.name);
        return { changed: true, problems: [] };
      }
    }
    throw new Error(`unexpected call ${method}`);
  }
  async first(method: string, payload: any): Promise<any> {
    this.calls.push({ method, payload });
    if (method === 'workflows.subscribe') return { workflows: [], runs: this.runs, questions: this.questions };
    throw new Error(`unexpected stream ${method}`);
  }
  close() {}
  methods() {
    return this.calls.map((c) => c.method);
  }
}

class FakeKube {
  patches: Array<{ plural: string; name: string; body: any }> = [];
  statuses: Array<{ plural: string; name: string; status: any }> = [];
  gates: Array<{ pod: string; ready: boolean }> = [];
  configMaps = new Map<string, Record<string, string>>();
  async patch(plural: string, name: string, body: unknown) {
    this.patches.push({ plural, name, body });
  }
  async patchStatus(plural: string, name: string, status: unknown) {
    this.statuses.push({ plural, name, status });
  }
  async configMapData(name: string) {
    return this.configMaps.get(name) ?? null;
  }
  async setContentReady(pod: string, ready: boolean) {
    this.gates.push({ pod, ready });
  }
  lastStatus() {
    return this.statuses.at(-1)?.status;
  }
}

const env = (name: string, overrides: Partial<Environment> = {}): Environment => ({
  name,
  uid: `uid-${name}`,
  ip: '10.0.0.1',
  ready: true,
  contentReady: undefined,
  ...overrides,
});

const defaultSets = (): PlacedSet[] => [
  { name: 'bugzoo', labels: { trust: 'personal' }, environments: [env('bugzoo-0'), env('bugzoo-1')] },
  { name: 'mice', labels: { trust: 'client' }, environments: [env('mice-0')] },
];

function setup(sets = defaultSets()) {
  const kube = new FakeKube();
  const servers = new Map(sets.flatMap((s) => (s.environments ?? []).map((e) => [e.name, new FakeT3()] as const)));
  const deps = { kube: kube as any, t3: (name: string) => servers.get(name)!, now: () => new Date('2026-11-25T10:00:00Z') };
  // What the T3EnvironmentSets' status says about who turned workflows on.
  let managed = new Map<string, boolean>();
  // Projects Ready per environment, as the pass's T3Projects left them.
  const ready = new Set<string>();
  let cr: WorkflowResource;
  return {
    kube,
    deps,
    server: (name: string) => servers.get(name)!,
    sets,
    ready,
    managed: () => managed,
    // One pass for the T3Workflow: as main.ts runs it, then feeds back its
    // status and finalizers as the API server would.
    async pass(resource: WorkflowResource, world = new World(sets)) {
      cr = resource;
      const hosts = new WorkflowHosts(deps, managed);
      const held = await reconcileWorkflow(deps, cr, world, hosts, (e, p) => ready.has(`${e}/${p}`));
      await hosts.release(world, new Set(held));
      managed = new Map([...servers.keys()].map((n) => [n, hosts.manages(n)]));
      const finalizers = kube.patches.filter((p) => p.plural === 't3workflows').at(-1)?.body.metadata.finalizers ?? cr.metadata.finalizers;
      return { ...cr, metadata: { ...cr.metadata, finalizers }, status: kube.lastStatus() } as WorkflowResource;
    },
  };
}

const v = (version: number, name = 'triage') => `workflow("${name}", { version: ${version}, payload: Issue }, body);\n`;

const workflow = (spec: Partial<WorkflowSpec> = {}, extra: Partial<WorkflowResource['metadata']> = {}): WorkflowResource => ({
  metadata: { name: 'triage', generation: 1, resourceVersion: '1', finalizers: [FINALIZER], ...extra },
  spec: { source: v(1), ...spec },
});
const FILE = workflowFileFor('triage');
const envStatus = (kube: FakeKube, name: string) => kube.lastStatus().environments.find((e: any) => e.name === name);
const holders = (kube: FakeKube) => kube.lastStatus().environments.map((e: any) => e.name);

// ─── tests ───────────────────────────────────────────────────────────────────

describe('reconcileWorkflow', () => {
  it('turns workflows on, saves k8s-<name>.ts, and reports it Ready', async () => {
    const { pass, kube, server, managed } = setup();
    await pass(workflow({ environmentSetSelector: { matchLabels: { trust: 'client' } } }));
    const t3 = server('mice-0');
    assert.equal(t3.enabled, true);
    assert.equal(t3.files.get(FILE), v(1));
    // On before anything is read or saved: t3 lists and saves nothing while off.
    assert.deepEqual(t3.methods().slice(0, 3), ['server.getConfig', 'server.updateSettings', 'workflows.getDefinition']);
    const status = kube.lastStatus();
    assert.equal(status.phase, 'Ready');
    assert.equal(status.message, null);
    assert.equal(status.observedGeneration, 1);
    assert.deepEqual(
      status.conditions.map((c: any) => [c.type, c.status, c.reason, c.observedGeneration]),
      [['Ready', 'True', 'Ready', 1]],
    );
    assert.deepEqual(envStatus(kube, 'mice-0').workflows, ['triage@1']);
    assert.equal(envStatus(kube, 'mice-0').sourceHash, status.sourceHash);
    assert.equal(managed().get('mice-0'), true);
  });

  it('adds its finalizer, conditional on the resourceVersion it read', async () => {
    const { pass, kube } = setup();
    await pass(workflow({}, { finalizers: [] }));
    assert.deepEqual(kube.patches[0], {
      plural: 't3workflows',
      name: 'triage',
      body: { metadata: { resourceVersion: '1', finalizers: [FINALIZER] } },
    });
  });

  it('saves only a file that is missing or differs, and restores one changed in t3', async () => {
    const { pass, kube, server } = setup();
    let cr = await pass(workflow({ environmentSetSelector: { matchLabels: { trust: 'client' } } }));
    const t3 = server('mice-0');
    t3.calls = [];
    const writes = kube.statuses.length;
    cr = await pass(cr);
    assert.ok(!t3.methods().includes('workflows.saveDefinition'), 'nothing saved when the file is as it should be');
    assert.equal(kube.statuses.length, writes, 'a settled status is not written again');

    t3.files.set(FILE, v(1) + '// edited in the app\n');
    await pass(cr);
    assert.equal(t3.files.get(FILE), v(1));
  });

  it('places on one environment by default, and on each with EachEnvironment', async () => {
    const { pass, kube, server } = setup();
    await pass(workflow());
    const placed = holders(kube);
    assert.equal(placed.length, 1);
    const files = ['bugzoo-0', 'bugzoo-1', 'mice-0'].filter((n) => server(n).files.has(FILE));
    assert.deepEqual(files, placed);

    const each = setup();
    await each.pass(workflow({ placement: 'EachEnvironment', environmentSetSelector: { matchLabels: { trust: 'personal' } } }));
    assert.deepEqual(holders(each.kube), ['bugzoo-0', 'bugzoo-1']);
    assert.equal(each.server('mice-0').calls.length, 0);
  });

  it('stays on its environment while that pod restarts, and moves once it is gone', async () => {
    const { pass, kube, sets } = setup();
    let cr = await pass(workflow());
    const [first] = holders(kube);
    const set = sets.find((s) => s.environments!.some((e) => e.name === first))!;
    const restarting = sets.map((s) =>
      s === set ? { ...s, environments: s.environments!.map((e) => (e.name === first ? { ...e, ready: false } : e)) } : s,
    );
    cr = await pass(cr, new World(restarting));
    assert.deepEqual(holders(kube), [first]);
    assert.equal(envStatus(kube, first).phase, 'Waiting');

    const gone = sets.map((s) => (s === set ? { ...s, environments: s.environments!.filter((e) => e.name !== first) } : s));
    await pass(cr, new World(gone));
    assert.equal(holders(kube).length, 1);
    assert.notEqual(holders(kube)[0], first);
  });

  it('waits for its projects to be Ready on an environment', async () => {
    const { pass, kube, server, ready } = setup();
    const spec = { projects: ['my-app'], environmentSetSelector: { matchLabels: { trust: 'client' } } };
    let cr = await pass(workflow(spec));
    assert.equal(kube.lastStatus().phase, 'Waiting');
    assert.equal(kube.lastStatus().message, 'waiting for a ready environment where my-app is Ready');
    assert.equal(server('mice-0').calls.length, 0);
    assert.deepEqual(kube.lastStatus().conditions[0].status, 'False');

    ready.add('mice-0/my-app');
    await pass(cr);
    assert.equal(kube.lastStatus().phase, 'Ready');
  });

  it('says so when no set matches', async () => {
    const { pass, kube } = setup();
    await pass(workflow({ environmentSetSelector: { matchLabels: { trust: 'nobody' } } }));
    assert.equal(kube.lastStatus().message, 'no environment set matches environmentSetSelector');
  });

  it('reads the source from a ConfigMap, and keeps the file while the ConfigMap is missing', async () => {
    const { pass, kube, server } = setup();
    const spec = { source: undefined, sourceFrom: { configMapKeyRef: { name: 'workflows', key: 'triage.ts' } }, environmentSetSelector: { matchLabels: { trust: 'client' } } };
    kube.configMaps.set('workflows', { 'triage.ts': v(1) });
    let cr = await pass(workflow(spec));
    assert.equal(server('mice-0').files.get(FILE), v(1));

    kube.configMaps.set('workflows', { 'triage.ts': v(2) });
    cr = await pass(cr);
    assert.equal(server('mice-0').files.get(FILE), v(2));

    kube.configMaps.delete('workflows');
    cr = await pass(cr);
    assert.equal(kube.lastStatus().phase, 'Error');
    assert.equal(kube.lastStatus().message, 'waiting for ConfigMap workflows');
    assert.equal(server('mice-0').files.get(FILE), v(2), 'no source is no reason to remove the file');
    assert.deepEqual(holders(kube), ['mice-0']);

    kube.configMaps.set('workflows', {});
    await pass(cr);
    assert.equal(kube.lastStatus().message, 'ConfigMap workflows has no key triage.ts');
  });

  it('refuses source and sourceFrom together', async () => {
    const { pass, kube } = setup();
    await pass(workflow({ sourceFrom: { configMapKeyRef: { name: 'x', key: 'y' } } }));
    assert.equal(kube.lastStatus().message, 'set spec.source or spec.sourceFrom, not both');
  });

  it('reports a file t3 refuses as Degraded, and the previous one keeps running', async () => {
    const { pass, kube, server } = setup();
    const selector = { environmentSetSelector: { matchLabels: { trust: 'client' } } };
    let cr = await pass(workflow(selector));
    cr = await pass({ ...cr, metadata: { ...cr.metadata, generation: 2 }, spec: { ...cr.spec, source: 'BROKEN' } });
    const status = kube.lastStatus();
    assert.equal(status.phase, 'Degraded');
    assert.equal(status.message, `mice-0: not applied, the previous file runs: ${FILE}:1: Expression expected`);
    assert.deepEqual(status.conditions[0].status, 'False');
    assert.equal(status.conditions[0].observedGeneration, 2);
    assert.equal(server('mice-0').files.get(FILE), v(1));
    assert.deepEqual(envStatus(kube, 'mice-0').workflows, ['triage@1']);
    assert.notEqual(envStatus(kube, 'mice-0').sourceHash, status.sourceHash, 'the environment still has the older file');
  });

  it('counts the runs that have not ended, and those that wait on a person', async () => {
    const { pass, kube, server } = setup();
    const selector = { environmentSetSelector: { matchLabels: { trust: 'client' } } };
    const cr = await pass(workflow(selector));
    const t3 = server('mice-0');
    t3.runs = [
      { runId: 'a', workflow: 'triage', version: 1, status: 'waiting' },
      { runId: 'b', workflow: 'triage', version: 1, status: 'paused' },
      { runId: 'c', workflow: 'triage', version: 1, status: 'running' },
      { runId: 'd', workflow: 'triage', version: 1, status: 'completed' },
      { runId: 'e', workflow: 'other', version: 1, status: 'waiting' },
    ];
    t3.questions = [{ runId: 'a', name: 'fix' }, { runId: 'e', name: 'x' }];
    await pass(cr);
    assert.deepEqual([envStatus(kube, 'mice-0').activeRuns, envStatus(kube, 'mice-0').needsYou], [3, 2]);
  });

  it('keeps a version whose runs are open until they end, then applies the change', async () => {
    const { pass, kube, server } = setup();
    const selector = { environmentSetSelector: { matchLabels: { trust: 'client' } } };
    let cr = await pass(workflow(selector));
    const t3 = server('mice-0');
    t3.runs = [{ runId: 'a', workflow: 'triage', version: 1, status: 'waiting' }];
    cr = await pass({ ...cr, spec: { ...cr.spec, source: v(2) } });
    assert.equal(kube.lastStatus().phase, 'Degraded');
    assert.match(kube.lastStatus().message, /triage@1 is no longer defined, and 1 of its runs has not ended/);
    assert.equal(t3.files.get(FILE), v(1));

    t3.runs = [{ runId: 'a', workflow: 'triage', version: 1, status: 'completed' }];
    await pass(cr);
    assert.equal(kube.lastStatus().phase, 'Ready');
    assert.equal(t3.files.get(FILE), v(2));
  });

  it('reports a t3 that reads its workflows from one file', async () => {
    const { pass, kube, server } = setup();
    server('mice-0').single = true;
    await pass(workflow({ environmentSetSelector: { matchLabels: { trust: 'client' } } }));
    assert.equal(kube.lastStatus().phase, 'Error');
    assert.match(kube.lastStatus().message, /reads its workflows from one file/);
  });

  it('reports an environment t3 cannot be reached on as Error, and goes on with the others', async () => {
    const { pass, kube, server } = setup();
    server('bugzoo-0').call = async () => {
      throw new Error('WebSocket to http://10.0.0.1:3773 failed');
    };
    await pass(workflow({ placement: 'EachEnvironment' }));
    assert.equal(kube.lastStatus().phase, 'Error');
    assert.equal(envStatus(kube, 'bugzoo-0').phase, 'Error');
    assert.equal(envStatus(kube, 'bugzoo-1').phase, 'Ready');
  });

  it('moves on while the old environment waits for its runs, and does not move back', async () => {
    const { pass, kube, server } = setup();
    let cr = await pass(workflow({ environmentSetSelector: { matchLabels: { trust: 'client' } } }));
    server('mice-0').runs = [{ runId: 'a', workflow: 'triage', version: 1, status: 'waiting' }];
    cr = await pass({ ...cr, spec: { ...cr.spec, environmentSetSelector: { matchLabels: { trust: 'personal' } } } });
    const [moved] = holders(kube).filter((n: string) => n !== 'mice-0');
    assert.ok(moved?.startsWith('bugzoo-'));
    assert.equal(envStatus(kube, 'mice-0').phase, 'Removing');
    assert.equal(server('mice-0').files.has(FILE), true);

    cr = await pass({ ...cr, spec: { ...cr.spec, environmentSetSelector: {} } });
    assert.equal(envStatus(kube, moved).phase, 'Ready');
    assert.equal(envStatus(kube, 'mice-0').phase, 'Removing', 'still on its way off, not chosen again');

    server('mice-0').runs = [];
    await pass(cr);
    assert.deepEqual(holders(kube), [moved]);
    assert.equal(server('mice-0').files.has(FILE), false);
  });

  it('takes the file off an environment its selector stops matching', async () => {
    const { pass, kube, server } = setup();
    let cr = await pass(workflow({ placement: 'EachEnvironment' }));
    assert.deepEqual(holders(kube), ['bugzoo-0', 'bugzoo-1', 'mice-0']);
    await pass({ ...cr, spec: { ...cr.spec, environmentSetSelector: { matchLabels: { trust: 'personal' } } } });
    assert.deepEqual(holders(kube), ['bugzoo-0', 'bugzoo-1']);
    assert.equal(server('mice-0').files.size, 0);
    assert.equal(server('mice-0').enabled, false, 'and turns workflows off again there');
  });
});

describe('reconcileWorkflow on deletion', () => {
  const deleting = (cr: WorkflowResource): WorkflowResource => ({ ...cr, metadata: { ...cr.metadata, deletionTimestamp: '2026-11-25T11:00:00Z' } });

  it('removes the file, turns workflows off where it turned them on, then drops its finalizer', async () => {
    const { pass, kube, server, managed } = setup();
    const cr = await pass(workflow({ placement: 'EachEnvironment' }));
    server('mice-0').files.set('mine.ts', 'workflow("mine", { version: 1, payload: X }, b);');
    const after = await pass(deleting(cr));
    for (const n of ['bugzoo-0', 'bugzoo-1', 'mice-0']) assert.equal(server(n).files.has(FILE), false);
    assert.deepEqual(after.metadata.finalizers, []);
    assert.equal(server('bugzoo-0').enabled, false);
    // A file someone else put there keeps workflows on, and no longer the
    // operator's to turn off.
    assert.equal(server('mice-0').enabled, true);
    assert.equal(managed().get('mice-0'), false);
  });

  it('leaves workflows on where it found them on', async () => {
    const { pass, server, managed } = setup();
    for (const n of ['bugzoo-0', 'bugzoo-1', 'mice-0']) server(n).enabled = true;
    const cr = await pass(workflow({ placement: 'EachEnvironment' }));
    assert.equal(managed().get('mice-0'), false);
    await pass(deleting(cr));
    assert.equal(server('mice-0').enabled, true);
    assert.equal(server('mice-0').files.size, 0);
  });

  it('keeps its finalizer while runs of the file are open', async () => {
    const { pass, kube, server } = setup();
    const cr = await pass(workflow({ environmentSetSelector: { matchLabels: { trust: 'client' } } }));
    const t3 = server('mice-0');
    t3.runs = [{ runId: 'a', workflow: 'triage', version: 1, status: 'waiting' }];
    let after = await pass(deleting(cr));
    assert.deepEqual(after.metadata.finalizers, [FINALIZER]);
    assert.equal(kube.lastStatus().phase, 'Deleting');
    assert.equal(envStatus(kube, 'mice-0').phase, 'Removing');
    assert.match(kube.lastStatus().message, /^mice-0: not removed yet: triage@1 is no longer defined/);
    assert.equal(t3.enabled, true, 'on while the file is there');

    t3.runs = [{ runId: 'a', workflow: 'triage', version: 1, status: 'cancelled' }];
    after = await pass(after);
    assert.deepEqual(after.metadata.finalizers, []);
    assert.equal(t3.files.size, 0);
    assert.equal(t3.enabled, false);
  });

  it('waits for a pod that is not ready', async () => {
    const { pass, kube, sets } = setup();
    const cr = await pass(workflow({ environmentSetSelector: { matchLabels: { trust: 'client' } } }));
    const down = sets.map((s) => (s.name === 'mice' ? { ...s, environments: [env('mice-0', { ready: false })] } : s));
    const after = await pass(deleting(cr), new World(down));
    assert.deepEqual(after.metadata.finalizers, [FINALIZER]);
    assert.equal(envStatus(kube, 'mice-0').message, 'removal waits for the pod');
  });

  it('leaves the file under deletionPolicy Retain', async () => {
    const { pass, server } = setup();
    const cr = await pass(workflow({ deletionPolicy: 'Retain', environmentSetSelector: { matchLabels: { trust: 'client' } } }));
    const after = await pass(deleting(cr));
    assert.deepEqual(after.metadata.finalizers, []);
    assert.equal(server('mice-0').files.get(FILE), v(1));
    assert.equal(server('mice-0').enabled, true, 'its file keeps workflows on');
  });
});

describe('reconcileEnvironmentSet and workflows', () => {
  it('records where the operator turned workflows on', async () => {
    const { deps, kube, sets } = setup();
    await reconcileEnvironmentSet(deps as any, { metadata: { name: 'mice' }, spec: { statefulSet: 'mice' } }, sets[1]!, new Map(), (e) => e === 'mice-0');
    assert.deepEqual(kube.lastStatus().environments.map((e: any) => [e.name, e.managesWorkflows]), [['mice-0', true]]);
    await reconcileEnvironmentSet(deps as any, { metadata: { name: 'mice' }, spec: { statefulSet: 'mice' } }, sets[1]!, new Map());
    assert.equal('managesWorkflows' in kube.lastStatus().environments[0], false);
  });
});
