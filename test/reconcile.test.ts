import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Environment, Kube } from '../src/kube.ts';
import {
  CLONE_GATE_MS,
  canonical,
  FINALIZER,
  RESYNC_MS,
  holdsGate,
  World,
  pickOne,
  reconcileEnvironmentSet,
  reconcileProject,
  type EnvironmentSetResource,
  type PlacedSet,
  type ProjectResource,
  type TaskSpec,
} from '../src/reconcile.ts';
import { T3Error, type T3, type T3Project } from '../src/t3.ts';

// ─── fakes ───────────────────────────────────────────────────────────────────

class FakeT3 implements T3 {
  projects: Array<T3Project & { archived?: boolean; pinned?: boolean }> = [];
  files = new Map<string, number>();
  cloning = new Set<string>();
  // Clones that have written .git, which projects.listEntries doesn't list.
  gitWritten = new Set<string>();
  existingCheckouts = new Set<string>();
  overrides: Record<string, unknown> = {};
  tasks = new Map<string, Record<string, unknown>>();
  calls: Array<{ method: string; payload: any }> = [];

  async listProjects() {
    return this.projects;
  }
  async mutateProject(m: any) {
    this.calls.push({ method: m.type, payload: m });
    if (m.type === 'project.create') {
      this.projects.push({ id: m.projectId, title: m.title, workspaceRoot: m.workspaceRoot, deletedAt: null });
    } else if (m.type === 'project.update') {
      const project = this.projects.find((p) => p.id === m.projectId);
      if (!project) throw new T3Error('Project not found');
      Object.assign(project, { title: m.title ?? project.title, archived: m.archived, pinned: m.pinned });
    } else if (m.type === 'project.delete') {
      this.projects = this.projects.filter((p) => p.id !== m.projectId);
    }
  }
  async call(method: string, payload: any): Promise<any> {
    this.calls.push({ method, payload });
    switch (method) {
      case 'projectClone.start': {
        // As t3 does: the destination is checked before any running clone.
        if (this.existingCheckouts.has(payload.destinationPath) || this.gitWritten.has(payload.destinationPath)) {
          throw new T3Error('Destination path already exists and is not empty.');
        }
        if (this.cloning.has(payload.destinationPath)) throw new T3Error('A clone into this destination is already in progress.');
        if (!this.projects.some((p) => p.workspaceRoot === payload.destinationPath)) {
          this.projects.push({ id: payload.projectId, title: payload.title, workspaceRoot: payload.destinationPath, deletedAt: null });
        }
        this.cloning.add(payload.destinationPath);
        return { projectId: payload.projectId };
      }
      case 'projects.listEntries':
        return { entries: Array.from({ length: this.files.get(payload.cwd) ?? 0 }, () => ({})) };
      case 'server.updateSettings':
        Object.assign(this.overrides, payload.patch.projectSettingsOverrides);
        return {};
      case 'scheduledTasks.upsert':
        this.tasks.set(payload.id, payload);
        return {};
      case 'scheduledTasks.delete':
        this.tasks.delete(payload.id);
        return {};
    }
    throw new Error(`unexpected call ${method}`);
  }
  close() {}
  // A project that is already cloned and registered.
  seed(id = 'k8s-infra', root = '/workspace/infra') {
    this.projects.push({ id, title: 'infra', workspaceRoot: root, deletedAt: null });
    this.files.set(root, 1);
    return this;
  }
  methods() {
    return this.calls.map((c) => c.method);
  }
}

class FakeKube implements Kube {
  patches: Array<{ plural: string; name: string; body: any }> = [];
  statuses: Array<{ plural: string; name: string; status: any }> = [];
  gates: Array<{ pod: string; ready: boolean; message: string }> = [];
  async list(): Promise<any> {
    return [];
  }
  async patch(plural: string, name: string, body: unknown) {
    this.patches.push({ plural, name, body });
  }
  async patchStatus(plural: string, name: string, status: unknown) {
    this.statuses.push({ plural, name, status });
  }
  async statefulSetEnvironments() {
    return [];
  }
  async setContentReady(pod: string, ready: boolean, message: string) {
    this.gates.push({ pod, ready, message });
  }
  lastStatus() {
    return this.statuses.at(-1)?.status;
  }
}

const env = (name: string, overrides: Partial<Environment> = {}): Environment => ({
  name,
  uid: `uid-${name}`,
  ip: `10.0.0.${name.length}`,
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
  let now = new Date('2026-11-13T10:00:00Z');
  const deps = { kube, t3: (name: string) => servers.get(name)!, now: () => now };
  return {
    kube,
    deps,
    server: (name: string) => servers.get(name)!,
    world: () => new World(sets),
    sets,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

const project = (spec: Partial<ProjectResource['spec']> = {}, extra: Partial<ProjectResource> = {}): ProjectResource => ({
  metadata: { name: 'infra', generation: 1, resourceVersion: '1', finalizers: [FINALIZER] },
  spec: { repository: 'git@github.com:derfred/infra.git', ...spec },
  ...extra,
});

const task = (overrides: Partial<TaskSpec> = {}): TaskSpec => ({
  prompt: 'Check charts.',
  schedule: { type: 'fixed_time', timeOfDay: '03:00' },
  modelSelection: { instanceId: 'claudeAgent', model: 'claude-haiku-5-5' },
  runtimeMode: 'full-access',
  ...overrides,
});

// Feeds the last written status back in, as the API server would.
const observed = (cr: ProjectResource, kube: FakeKube): ProjectResource => ({ ...cr, status: kube.lastStatus() });
const envStatus = (kube: FakeKube, name: string) => kube.lastStatus().environments.find((e: any) => e.name === name);

// ─── placement ───────────────────────────────────────────────────────────────

describe('reconcileProject placement', () => {
  it('places on every environment of every set by default', async () => {
    const { deps, kube, world } = setup();
    await reconcileProject(deps, project(), world());
    assert.deepEqual(kube.lastStatus().environments.map((e: any) => e.name), ['bugzoo-0', 'bugzoo-1', 'mice-0']);
  });

  it('places only on the sets its selector matches', async () => {
    const { deps, kube, world, server } = setup();
    const statuses = await reconcileProject(
      deps,
      project({ environmentSetSelector: { matchExpressions: [{ key: 'trust', operator: 'NotIn', values: ['client'] }] } }),
      world(),
    );
    assert.deepEqual(statuses.map((s) => s.name), ['bugzoo-0', 'bugzoo-1']);
    assert.deepEqual(server('mice-0').calls, []);
    assert.equal(envStatus(kube, 'bugzoo-0').environmentSet, 'bugzoo');
  });

  it('says so when no set matches', async () => {
    const { deps, kube, world } = setup();
    await reconcileProject(deps, project({ environmentSetSelector: { matchLabels: { trust: 'nobody' } } }), world());
    assert.equal(kube.lastStatus().message, 'no environment set matches environmentSetSelector');
    assert.equal(kube.lastStatus().phase, 'Waiting');
  });

  it('takes the project off an environment its selector stops matching, by deletionPolicy', async () => {
    const { deps, kube, world, server } = setup();
    for (const name of ['bugzoo-0', 'bugzoo-1', 'mice-0']) server(name).seed();
    let cr = project({ settings: { branchNamePrefix: 'x/' } });
    await reconcileProject(deps, cr, world());
    cr = observed({ ...cr, spec: { ...cr.spec, environmentSetSelector: { matchLabels: { trust: 'personal' } } } }, kube);
    await reconcileProject(deps, cr, world());
    assert.equal(server('mice-0').projects[0]!.archived, true);
    assert.deepEqual(server('mice-0').overrides, { 'k8s-infra': null });
    assert.equal(envStatus(kube, 'mice-0'), undefined);
  });

  it('forgets an environment whose pod is gone without touching it', async () => {
    const sets = defaultSets();
    const { deps, kube, server } = setup(sets);
    await reconcileProject(deps, project(), new World(sets));
    const cr = observed(project(), kube);
    const scaledDown = [{ ...sets[0]!, environments: [sets[0]!.environments![0]!] }, sets[1]!];
    const before = server('bugzoo-1').calls.length;
    await reconcileProject(deps, cr, new World(scaledDown));
    assert.equal(envStatus(kube, 'bugzoo-1'), undefined);
    assert.equal(server('bugzoo-1').calls.length, before);
  });
});

// ─── the project on an environment ───────────────────────────────────────────

describe('reconcileProject on an environment', () => {
  const one = (): PlacedSet[] => [{ name: 'bugzoo', labels: {}, environments: [env('bugzoo-0')] }];

  it('adds the finalizer, conditional on the resourceVersion it read', async () => {
    const { deps, kube, world } = setup(one());
    await reconcileProject(deps, project({}, { metadata: { name: 'infra', resourceVersion: '7' } }), world());
    assert.deepEqual(kube.patches[0]!.body, { metadata: { resourceVersion: '7', finalizers: [FINALIZER] } });
  });

  it('clones, then applies fields and overrides once the checkout has files', async () => {
    const { deps, kube, world, server } = setup(one());
    const t3 = server('bugzoo-0');
    let cr = project({ project: { autoPull: true }, settings: { branchNamePrefix: 'bz/' } });
    await reconcileProject(deps, cr, world());
    assert.deepEqual(t3.calls[0], {
      method: 'projectClone.start',
      payload: {
        projectId: 'k8s-infra',
        title: 'infra',
        createdAt: '2026-11-13T10:00:00.000Z',
        remoteUrl: 'git@github.com:derfred/infra.git',
        destinationPath: '/workspace/infra',
      },
    });
    assert.equal(envStatus(kube, 'bugzoo-0').phase, 'Cloning');

    const startedAt = envStatus(kube, 'bugzoo-0').cloningSince;
    await reconcileProject(deps, (cr = observed(cr, kube)), world());
    assert.equal(envStatus(kube, 'bugzoo-0').phase, 'Cloning', 'a second start reports "in progress"');
    assert.equal(envStatus(kube, 'bugzoo-0').cloningSince, startedAt, 'the clone keeps its start time');

    t3.gitWritten.add('/workspace/infra');
    await reconcileProject(deps, (cr = observed(cr, kube)), world());
    assert.equal(envStatus(kube, 'bugzoo-0').phase, 'Cloning', 'only .git yet: t3 says "not empty", still cloning');
    assert.equal(envStatus(kube, 'bugzoo-0').message, 'cloning git@github.com:derfred/infra.git into /workspace/infra');

    t3.cloning.clear();
    t3.files.set('/workspace/infra', 3);
    await reconcileProject(deps, observed(cr, kube), world());
    assert.equal(kube.lastStatus().phase, 'Ready');
    const update = t3.calls.find((c) => c.method === 'project.update')!.payload;
    assert.equal(update.autoPull, true);
    assert.equal(update.archived, false);
    assert.deepEqual(t3.overrides, { 'k8s-infra': { branchNamePrefix: 'bz/' } });
  });

  it('re-applies only on a spec change, a new pod, or the resync interval', async () => {
    const sets = one();
    const { deps, kube, server, advance } = setup(sets);
    const t3 = server('bugzoo-0').seed();
    const updates = () => t3.calls.filter((c) => c.method === 'project.update').length;
    let cr = project();
    await reconcileProject(deps, cr, new World(sets));
    await reconcileProject(deps, (cr = observed(cr, kube)), new World(sets));
    assert.equal(updates(), 1);

    await reconcileProject(deps, (cr = observed({ ...cr, spec: { ...cr.spec, title: 'Infra' } }, kube)), new World(sets));
    assert.equal(updates(), 2);

    const restarted = [{ ...sets[0]!, environments: [env('bugzoo-0', { uid: 'uid-new' })] }];
    await reconcileProject(deps, (cr = observed(cr, kube)), new World(restarted));
    assert.equal(updates(), 3);

    advance(RESYNC_MS);
    await reconcileProject(deps, observed(cr, kube), new World(restarted));
    assert.equal(updates(), 4);
  });

  it('registers a checkout already on disk instead of cloning over it', async () => {
    const { deps, kube, world, server } = setup(one());
    const t3 = server('bugzoo-0');
    t3.existingCheckouts.add('/workspace/infra');
    t3.files.set('/workspace/infra', 5);
    await reconcileProject(deps, project(), world());
    assert.deepEqual(t3.methods(), ['projectClone.start', 'project.create', 'projects.listEntries', 'project.update']);
    assert.equal(envStatus(kube, 'bugzoo-0').phase, 'Ready');
  });

  it('adopts a project registered at the same path by hand', async () => {
    const { deps, kube, world, server } = setup(one());
    server('bugzoo-0').seed('hand-made');
    await reconcileProject(deps, project(), world());
    assert.equal(envStatus(kube, 'bugzoo-0').projectId, 'hand-made');
    assert.equal(envStatus(kube, 'bugzoo-0').message, 'adopted existing project hand-made');
  });

  it('clears the overrides it set once `settings` leaves the spec', async () => {
    const { deps, kube, world, server } = setup(one());
    const t3 = server('bugzoo-0').seed();
    const cr = project({ settings: { defaultAutoPull: true } });
    await reconcileProject(deps, cr, world());
    await reconcileProject(deps, observed({ ...cr, spec: project().spec }, kube), world());
    assert.deepEqual(t3.overrides, { 'k8s-infra': null });
    assert.equal(envStatus(kube, 'bugzoo-0').managesSettings, false);
  });

  it('marks an environment whose containers are not ready as Waiting', async () => {
    const { deps, kube } = setup(one());
    await reconcileProject(deps, project(), new World([{ name: 'bugzoo', labels: {}, environments: [env('bugzoo-0', { ready: false })] }]));
    assert.equal(envStatus(kube, 'bugzoo-0').phase, 'Waiting');
  });

  it('skips the write for a status the API server hands back reordered and without its nulls', async () => {
    const { deps, kube, world, server } = setup(one());
    server('bugzoo-0').seed();
    await reconcileProject(deps, project(), world());
    const writes = kube.statuses.length;
    // What a GET returns after the merge patch: keys sorted, null fields deleted.
    const stored = JSON.parse(JSON.stringify(canonical(kube.lastStatus())));
    assert.equal('message' in stored, false);
    await reconcileProject(deps, { ...project(), status: stored }, world());
    assert.equal(kube.statuses.length, writes);
  });

  it('skips the status write when nothing changed', async () => {
    const { deps, kube, world, server } = setup(one());
    server('bugzoo-0').seed();
    await reconcileProject(deps, project(), world());
    const writes = kube.statuses.length;
    await reconcileProject(deps, observed(project(), kube), world());
    assert.equal(kube.statuses.length, writes);
  });
});

// ─── deletion ────────────────────────────────────────────────────────────────

describe('reconcileProject on deletion', () => {
  const deleting = (policy?: 'Archive' | 'Delete' | 'Retain') =>
    project(policy ? { deletionPolicy: policy } : {}, {
      metadata: { name: 'infra', resourceVersion: '9', deletionTimestamp: 'now', finalizers: [FINALIZER, 'other'] },
      status: {
        environments: [
          {
            name: 'bugzoo-0',
            environmentSet: 'bugzoo',
            phase: 'Ready',
            message: null,
            podUID: 'uid-bugzoo-0',
            projectId: 'k8s-infra',
            appliedHash: 'h',
            appliedAt: '2026-11-13T09:00:00Z',
            managesSettings: true,
            tasks: [{ name: 'charts', appliedHash: 'h', appliedAt: '2026-11-13T09:00:00Z' }],
          },
        ],
      },
    });

  it('removes its tasks, archives, clears overrides, then drops only its finalizer', async () => {
    const { deps, kube, world, server } = setup();
    const t3 = server('bugzoo-0').seed();
    t3.tasks.set('k8s-infra-charts', {});
    await reconcileProject(deps, deleting(), world());
    assert.equal(t3.tasks.size, 0);
    assert.equal(t3.projects[0]!.archived, true);
    assert.deepEqual(t3.overrides, { 'k8s-infra': null });
    assert.deepEqual(kube.patches, [
      { plural: 't3projects', name: 'infra', body: { metadata: { resourceVersion: '9', finalizers: ['other'] } } },
    ]);
  });

  it('deletes the project with its threads under deletionPolicy Delete', async () => {
    const { deps, world, server } = setup();
    const t3 = server('bugzoo-0').seed();
    await reconcileProject(deps, deleting('Delete'), world());
    assert.equal(t3.calls.at(-1)?.payload.force, true);
    assert.equal(t3.projects.length, 0);
  });

  it('keeps the project under Retain, but still removes its tasks', async () => {
    const { deps, world, server } = setup();
    const t3 = server('bugzoo-0').seed();
    await reconcileProject(deps, deleting('Retain'), world());
    assert.deepEqual(t3.methods(), ['scheduledTasks.delete']);
  });

  it('waits for an environment that is not ready, keeping the finalizer', async () => {
    const { deps, kube } = setup();
    await reconcileProject(deps, deleting(), new World([{ name: 'bugzoo', labels: {}, environments: [env('bugzoo-0', { ready: false })] }]));
    assert.deepEqual(kube.patches, []);
    assert.equal(kube.lastStatus().phase, 'Deleting');
  });
});

// ─── tasks ───────────────────────────────────────────────────────────────────

describe('task placement', () => {
  const seeded = (sets = defaultSets()) => {
    const s = setup(sets);
    for (const set of sets) for (const e of set.environments ?? []) s.server(e.name).seed();
    return s;
  };
  const holders = (kube: FakeKube, name = 'charts') =>
    kube.lastStatus().tasks.find((t: any) => t.name === name)?.environments;

  it('places a task on one eligible environment by default, with that environment’s project id', async () => {
    const { deps, kube, world, server } = seeded();
    await reconcileProject(deps, project({ tasks: { charts: task() } }), world());
    const chosen = pickOne('charts', ['bugzoo-0', 'bugzoo-1', 'mice-0']);
    assert.deepEqual(holders(kube), [chosen]);
    assert.deepEqual(server(chosen).tasks.get('k8s-infra-charts'), {
      id: 'k8s-infra-charts',
      title: 'infra: charts',
      prompt: 'Check charts.',
      enabled: true,
      schedule: { type: 'fixed_time', timeOfDay: '03:00' },
      projectId: 'k8s-infra',
      workspaceStrategy: { type: 'root' },
      modelSelection: { instanceId: 'claudeAgent', model: 'claude-haiku-5-5' },
      runtimeMode: 'full-access',
      interactionMode: 'default',
    });
    const others = ['bugzoo-0', 'bugzoo-1', 'mice-0'].filter((n) => n !== chosen);
    for (const name of others) assert.equal(server(name).tasks.size, 0);
  });

  it('narrows by the task’s own selector, and places on each with EachEnvironment', async () => {
    const { deps, kube, world } = seeded();
    await reconcileProject(
      deps,
      project({ tasks: { charts: task({ placement: 'EachEnvironment', environmentSetSelector: { matchLabels: { trust: 'personal' } } }) } }),
      world(),
    );
    assert.deepEqual(holders(kube), ['bugzoo-0', 'bugzoo-1']);
  });

  it('stays on its environment while that pod restarts, and moves once it is gone', async () => {
    const sets: PlacedSet[] = [{ name: 'bugzoo', labels: {}, environments: [env('bugzoo-0'), env('bugzoo-1')] }];
    const { deps, kube, server } = seeded(sets);
    let cr = project({ tasks: { charts: task({ environmentSetSelector: {} }) } });
    await reconcileProject(deps, cr, new World(sets));
    const first = holders(kube)[0];
    const other = first === 'bugzoo-0' ? 'bugzoo-1' : 'bugzoo-0';

    const restarting = [{ ...sets[0]!, environments: sets[0]!.environments!.map((e) => (e.name === first ? { ...e, ready: false } : e)) }];
    await reconcileProject(deps, (cr = observed(cr, kube)), new World(restarting));
    assert.deepEqual(holders(kube), [first]);
    assert.equal(server(other).tasks.size, 0);

    const gone = [{ ...sets[0]!, environments: sets[0]!.environments!.filter((e) => e.name !== first) }];
    await reconcileProject(deps, observed(cr, kube), new World(gone));
    assert.deepEqual(holders(kube), [other]);
    assert.ok(server(other).tasks.has('k8s-infra-charts'));
  });

  it('removes a task taken out of the spec', async () => {
    const { deps, kube, world, server } = seeded();
    const cr = project({ tasks: { charts: task() } });
    await reconcileProject(deps, cr, world());
    const holder = holders(kube)[0];
    await reconcileProject(deps, observed({ ...cr, spec: { ...cr.spec, tasks: {} } }, kube), world());
    assert.equal(server(holder).tasks.size, 0);
    assert.deepEqual(kube.lastStatus().tasks, []);
  });

  it('waits until the project is ready somewhere it may go', async () => {
    const { deps, kube, world } = setup();
    await reconcileProject(deps, project({ tasks: { charts: task() } }), world());
    assert.deepEqual(kube.lastStatus().tasks, [
      { name: 'charts', environments: [], message: 'waiting for the project on a matching environment' },
    ]);
  });
});

// ─── T3EnvironmentSet ────────────────────────────────────────────────────────

describe('reconcileEnvironmentSet', () => {
  const setCr: EnvironmentSetResource = { metadata: { name: 'bugzoo', generation: 2 }, spec: { statefulSet: 't3code-bugzoo' } };

  it('opens the gate once no placed project is still on its way; an Error does not hold it', async () => {
    const { deps, kube } = setup();
    const set: PlacedSet = { name: 'bugzoo', labels: {}, environments: [env('bugzoo-0'), env('bugzoo-1'), env('bugzoo-2')] };
    await reconcileEnvironmentSet(
      deps,
      setCr,
      set,
      new Map([
        [
          'bugzoo-0',
          [
            { project: 'infra', phase: 'Ready' as const, cloningSince: null },
            { project: 'broken', phase: 'Error' as const, cloningSince: null },
          ],
        ],
        ['bugzoo-1', [{ project: 'infra', phase: 'Cloning' as const, cloningSince: '2026-11-13T09:55:00Z' }]],
      ]),
    );
    assert.deepEqual(kube.gates, [
      { pod: 'bugzoo-0', ready: true, message: '2 project(s) in place' },
      { pod: 'bugzoo-1', ready: false, message: 'waiting for infra' },
      { pod: 'bugzoo-2', ready: true, message: '0 project(s) in place' },
    ]);
    assert.equal(kube.lastStatus().phase, 'Progressing');
  });

  it('stops holding the gate for a clone that has not finished in CLONE_GATE_MS', () => {
    const now = new Date('2026-11-13T10:00:00Z');
    const since = (ms: number) => new Date(now.getTime() - ms).toISOString();
    assert.equal(holdsGate({ project: 'p', phase: 'Cloning', cloningSince: since(CLONE_GATE_MS - 1) }, now), true);
    assert.equal(holdsGate({ project: 'p', phase: 'Cloning', cloningSince: since(CLONE_GATE_MS) }, now), false);
    assert.equal(holdsGate({ project: 'p', phase: 'Waiting', cloningSince: null }, now), true);
    assert.equal(holdsGate({ project: 'p', phase: 'Error', cloningSince: null }, now), false);
  });

  it('leaves a gate that already says the right thing alone', async () => {
    const { deps, kube } = setup();
    const set: PlacedSet = { name: 'bugzoo', labels: {}, environments: [env('bugzoo-0', { contentReady: true })] };
    await reconcileEnvironmentSet(deps, setCr, set, new Map());
    assert.deepEqual(kube.gates, []);
    assert.equal(kube.lastStatus().phase, 'Ready');
  });

  it('reports a missing StatefulSet', async () => {
    const { deps, kube } = setup();
    await reconcileEnvironmentSet(deps, setCr, { name: 'bugzoo', labels: {}, environments: null }, new Map());
    assert.equal(kube.lastStatus().message, 'StatefulSet t3code-bugzoo not found');
  });
});
