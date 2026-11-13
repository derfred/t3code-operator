// Level-triggered reconciliation. An environment is one t3 pod; an
// environment set is the StatefulSet that makes a group of them. A T3Project
// selects sets by label and is placed on every environment of every set it
// selects; its tasks (t3 scheduled tasks) are placed on one, or each, of
// those. t3 itself runs the tasks: the operator only decides which
// environments hold their definitions. See docs/design.md.

import { createHash, randomUUID } from 'node:crypto';
import type { Environment, Kube, Resource } from './kube.ts';
import { matches, type LabelSelector } from './selector.ts';
import type { T3, T3Project } from './t3.ts';

export const FINALIZER = 't3code.derfred.com/cleanup';
// Re-apply unchanged specs this often, to repair edits made in the t3 UI.
export const RESYNC_MS = 60 * 60 * 1000;
// t3 does not report a failed clone to the operator, only an empty folder, so
// a clone holds the readiness gate this long at most: a broken repository
// must not stall every later rollout.
export const CLONE_GATE_MS = 15 * 60 * 1000;

export type Phase = 'Waiting' | 'Cloning' | 'Ready' | 'Error';

export interface TaskSpec {
  readonly title?: string;
  readonly prompt: string;
  readonly enabled?: boolean;
  readonly schedule: Record<string, unknown>;
  readonly modelSelection: Record<string, unknown>;
  readonly runtimeMode: string;
  readonly interactionMode?: string;
  readonly workspaceStrategy?: Record<string, unknown>;
  readonly threadMode?: string;
  // Narrows the project's selector; {} adds nothing.
  readonly environmentSetSelector?: LabelSelector;
  readonly placement?: 'One' | 'EachEnvironment';
}

export interface ProjectSpec {
  readonly repository: string;
  readonly path?: string;
  readonly title?: string;
  readonly project?: Record<string, unknown>;
  readonly settings?: Record<string, unknown>;
  readonly deletionPolicy?: 'Archive' | 'Delete' | 'Retain';
  readonly environmentSetSelector?: LabelSelector;
  readonly tasks?: Readonly<Record<string, TaskSpec>>;
}

export interface TaskPlacement {
  readonly name: string;
  readonly appliedHash: string;
  readonly appliedAt: string;
}

// Status lists rather than maps: a merge patch replaces a list whole, so an
// entry dropped here is gone, where a dropped map key would linger.
export interface EnvironmentStatus {
  readonly name: string;
  readonly environmentSet: string;
  readonly phase: Phase;
  readonly message: string | null;
  readonly podUID: string | null;
  readonly projectId: string | null;
  readonly appliedHash: string | null;
  readonly appliedAt: string | null;
  readonly managesSettings: boolean;
  readonly cloningSince: string | null;
  readonly tasks: ReadonlyArray<TaskPlacement>;
}

export interface TaskStatus {
  readonly name: string;
  readonly environments: ReadonlyArray<string>;
  readonly message: string | null;
}

export interface ProjectStatus {
  readonly observedGeneration?: number | null;
  readonly phase?: string;
  readonly message?: string | null;
  readonly environments?: ReadonlyArray<EnvironmentStatus>;
  readonly tasks?: ReadonlyArray<TaskStatus>;
}

export type ProjectResource = Resource<ProjectSpec, ProjectStatus>;
export type EnvironmentSetResource = Resource<{ readonly statefulSet: string }, unknown>;

// What one pass observed: every set with its environments (null when its
// StatefulSet is missing).
export interface PlacedSet {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly environments: ReadonlyArray<Environment> | null;
}

export interface Deps {
  readonly kube: Kube;
  readonly t3: (environment: string) => T3;
  readonly now: () => Date;
}

export const projectIdFor = (name: string) => `k8s-${name}`;
export const taskIdFor = (project: string, task: string) => `k8s-${project}-${task}`;
export const workspaceRootFor = (cr: ProjectResource) => cr.spec.path ?? `/workspace/${cr.metadata.name}`;

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const byName = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

export function environmentStatus(
  fields: Partial<EnvironmentStatus> & Pick<EnvironmentStatus, 'name' | 'environmentSet' | 'phase'>,
): EnvironmentStatus {
  return {
    message: null,
    podUID: null,
    projectId: null,
    appliedHash: null,
    appliedAt: null,
    managesSettings: false,
    cloningSince: null,
    tasks: [],
    ...fields,
  };
}

export function needsApply(
  previous: { readonly appliedHash: string | null; readonly appliedAt: string | null } | undefined,
  previousPodUID: string | null | undefined,
  digest: string,
  pod: Environment,
  now: Date,
): boolean {
  if (!previous || previous.appliedHash !== digest || previousPodUID !== pod.uid || !previous.appliedAt) return true;
  return now.getTime() - Date.parse(previous.appliedAt) >= RESYNC_MS;
}

export function aggregatePhase(environments: ReadonlyArray<EnvironmentStatus>): string {
  const phases = environments.map((e) => e.phase);
  if (phases.length === 0) return 'Waiting';
  if (phases.includes('Error')) return 'Error';
  if (phases.every((phase) => phase === 'Ready')) return 'Ready';
  return 'Progressing';
}

// A task with placement One lands on the same environment pass after pass,
// and different tasks spread over the environments.
export function pickOne(task: string, candidates: ReadonlyArray<string>): string {
  const sorted = [...candidates].sort(byName);
  return sorted[Number.parseInt(hash(task).slice(0, 8), 16) % sorted.length]!;
}

// Status as the API server hands it back: object keys sorted (it is a Go map
// there), and null fields gone (a merge patch deletes them). Inside arrays,
// which a merge patch replaces whole, nulls survive.
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => (v === null ? null : canonical(v)));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((k) => (value as any)[k] !== null && (value as any)[k] !== undefined)
      .map((k) => [k, canonical((value as any)[k])]),
  );
}

async function writeStatus(deps: Deps, plural: string, cr: Resource<unknown, any>, status: Record<string, unknown>) {
  const next = { observedGeneration: cr.metadata.generation ?? null, ...status };
  // Unchanged: skip the write. Not just to save API calls: the operator
  // watches its own resources, so every write is another pass.
  if (JSON.stringify(canonical(next)) === JSON.stringify(canonical(cr.status ?? {}))) return;
  await deps.kube.patchStatus(plural, cr.metadata.name, next);
}

async function addFinalizer(deps: Deps, cr: ProjectResource) {
  if (cr.metadata.finalizers?.includes(FINALIZER)) return;
  await deps.kube.patch('t3projects', cr.metadata.name, {
    metadata: { resourceVersion: cr.metadata.resourceVersion, finalizers: [...(cr.metadata.finalizers ?? []), FINALIZER] },
  });
}

async function removeFinalizer(deps: Deps, cr: ProjectResource) {
  await deps.kube.patch('t3projects', cr.metadata.name, {
    metadata: {
      resourceVersion: cr.metadata.resourceVersion,
      finalizers: (cr.metadata.finalizers ?? []).filter((f) => f !== FINALIZER),
    },
  });
}

// ─── the project on one environment ──────────────────────────────────────────

function startClone(t3: T3, cr: ProjectResource, projectId: string, now: Date) {
  return t3.call('projectClone.start', {
    projectId,
    title: cr.spec.title ?? cr.metadata.name,
    createdAt: now.toISOString(),
    remoteUrl: cr.spec.repository,
    destinationPath: workspaceRootFor(cr),
  }) as Promise<{ projectId?: string }>;
}

async function syncProject(
  deps: Deps,
  cr: ProjectResource,
  env: Environment,
  set: string,
  previous: EnvironmentStatus | undefined,
): Promise<EnvironmentStatus> {
  const t3 = deps.t3(env.name);
  const now = deps.now();
  const name = cr.metadata.name;
  const root = workspaceRootFor(cr);
  const title = cr.spec.title ?? name;
  const carried = {
    name: env.name,
    environmentSet: set,
    podUID: env.uid,
    managesSettings: previous?.managesSettings ?? false,
    tasks: previous?.tasks ?? [],
  };
  const cloningSince = previous?.phase === 'Cloning' && previous.cloningSince ? previous.cloningSince : now.toISOString();

  const live = (await t3.listProjects()).filter((p) => p.deletedAt === null);
  // Prefer the id this environment already uses; else adopt a project
  // registered at the same path by hand, so it keeps its threads.
  let project: Pick<T3Project, 'id'> | undefined =
    live.find((p) => p.id === (previous?.projectId ?? projectIdFor(name))) ?? live.find((p) => p.workspaceRoot === root);

  if (!project) {
    const projectId = projectIdFor(name);
    try {
      const started = await startClone(t3, cr, projectId, now);
      return environmentStatus({
        ...carried,
        phase: 'Cloning',
        cloningSince,
        projectId: started?.projectId ?? projectId,
        message: `cloning ${cr.spec.repository} into ${root}`,
      });
    } catch (error) {
      // A checkout already on disk is registered as it is, not re-cloned.
      if (!/not empty/i.test(errorMessage(error))) throw error;
      await t3.mutateProject({ type: 'project.create', commandId: randomUUID(), projectId, title, workspaceRoot: root });
      project = { id: projectId };
    }
  }
  const projectId = project.id;

  // projectClone.start registers the project before git runs, so an existing
  // project can still be an unfinished or failed clone. Check until it has
  // files once; after that it is Ready and the check is skipped.
  if (previous?.phase !== 'Ready' || previous.projectId !== projectId) {
    const listing = (await t3.call('projects.listEntries', { cwd: root })) as { entries: ReadonlyArray<unknown> };
    if (listing.entries.length === 0) {
      try {
        await startClone(t3, cr, projectId, now);
      } catch (error) {
        if (!/in progress/i.test(errorMessage(error))) throw error;
      }
      return environmentStatus({
        ...carried,
        phase: 'Cloning',
        cloningSince,
        projectId,
        message: `cloning ${cr.spec.repository} into ${root}`,
      });
    }
  }

  const digest = hash({ title, project: cr.spec.project ?? {}, settings: cr.spec.settings ?? null });
  let applied = { appliedHash: previous?.appliedHash ?? null, appliedAt: previous?.appliedAt ?? null };
  let managesSettings = carried.managesSettings;
  if (needsApply(previous, previous?.podUID, digest, env, now)) {
    await t3.mutateProject({
      // Unarchive a project an earlier Archive left behind.
      archived: false,
      ...cr.spec.project,
      type: 'project.update',
      commandId: randomUUID(),
      projectId,
      title,
    });
    // `settings` replaces the project's whole override set; removing it from
    // the spec clears the overrides this operator set.
    if (cr.spec.settings !== undefined || managesSettings) {
      await t3.call('server.updateSettings', {
        patch: { projectSettingsOverrides: { [projectId]: cr.spec.settings ?? null } },
      });
      managesSettings = cr.spec.settings !== undefined;
    }
    applied = { appliedHash: digest, appliedAt: now.toISOString() };
  }

  return environmentStatus({
    ...carried,
    phase: 'Ready',
    projectId,
    managesSettings,
    ...applied,
    message: projectId === projectIdFor(name) ? null : `adopted existing project ${projectId}`,
  });
}

// Takes the project off one environment: its tasks, then the project itself
// per deletionPolicy. Used on deletion and when the selector stops matching.
async function removeFromEnvironment(deps: Deps, cr: ProjectResource, env: Environment, status: EnvironmentStatus) {
  const t3 = deps.t3(env.name);
  for (const task of status.tasks) {
    // Idempotent on the server: deleting a missing task succeeds.
    await t3.call('scheduledTasks.delete', { id: taskIdFor(cr.metadata.name, task.name) });
  }
  const policy = cr.spec.deletionPolicy ?? 'Archive';
  if (policy === 'Retain' || status.projectId === null) return;
  if (status.managesSettings) {
    await t3.call('server.updateSettings', { patch: { projectSettingsOverrides: { [status.projectId]: null } } });
  }
  const exists = (await t3.listProjects()).some((p) => p.id === status.projectId && p.deletedAt === null);
  if (!exists) return;
  await t3.mutateProject(
    policy === 'Delete'
      ? { type: 'project.delete', commandId: randomUUID(), projectId: status.projectId, force: true }
      : { type: 'project.update', commandId: randomUUID(), projectId: status.projectId, archived: true },
  );
}

// ─── tasks ───────────────────────────────────────────────────────────────────

function upsertPayload(project: string, task: string, spec: TaskSpec, projectId: string) {
  return {
    id: taskIdFor(project, task),
    title: spec.title ?? `${project}: ${task}`,
    prompt: spec.prompt,
    enabled: spec.enabled ?? true,
    schedule: spec.schedule,
    projectId,
    workspaceStrategy: spec.workspaceStrategy ?? { type: 'root' },
    modelSelection: spec.modelSelection,
    runtimeMode: spec.runtimeMode,
    interactionMode: spec.interactionMode ?? 'default',
    ...(spec.threadMode === undefined ? {} : { threadMode: spec.threadMode }),
  };
}

// Places every task of the project on its environments, and takes it off the
// ones it no longer belongs on. Mutates `entries` (keyed by environment).
async function placeTasks(
  deps: Deps,
  cr: ProjectResource,
  world: World,
  targeted: ReadonlySet<string>,
  entries: Map<string, EnvironmentStatus>,
  previous: ReadonlyMap<string, EnvironmentStatus>,
): Promise<TaskStatus[]> {
  const project = cr.metadata.name;
  const specs = cr.spec.tasks ?? {};
  const now = deps.now();
  const holders = new Map<string, string[]>();
  for (const entry of entries.values()) {
    for (const t of entry.tasks) holders.set(t.name, [...(holders.get(t.name) ?? []), entry.name]);
  }
  const setPlacement = (env: string, task: string, placement: TaskPlacement | null) => {
    const entry = entries.get(env)!;
    const rest = entry.tasks.filter((t) => t.name !== task);
    entries.set(env, { ...entry, tasks: placement ? [...rest, placement].sort((a, b) => byName(a.name, b.name)) : rest });
  };

  const summary: TaskStatus[] = [];
  for (const task of [...new Set([...Object.keys(specs), ...holders.keys()])].sort(byName)) {
    const spec = specs[task];
    const holding = holders.get(task) ?? [];
    let chosen: string[] = [];
    let message: string | null = null;

    if (spec) {
      // Environments the task may be on: the project's, narrowed by the
      // task's own selector. Eligible: those where the project is Ready.
      const candidates = [...entries.values()]
        .filter((e) => targeted.has(e.name) && matches(spec.environmentSetSelector, world.labelsOf(e.environmentSet)))
        .map((e) => e.name);
      const eligible = candidates.filter((n) => entries.get(n)!.phase === 'Ready' && entries.get(n)!.projectId !== null);
      // An environment that holds the task keeps it while it is a candidate,
      // ready or not: moving a task restarts its thread elsewhere, which a
      // pod restart must not cause.
      const kept = holding.filter((n) => candidates.includes(n));
      if ((spec.placement ?? 'One') === 'One') {
        chosen = kept.length > 0 ? [kept.sort(byName)[0]!] : eligible.length > 0 ? [pickOne(task, eligible)] : [];
      } else {
        chosen = [...new Set([...eligible, ...kept])].sort(byName);
      }
      if (chosen.length === 0) {
        message = candidates.length === 0 ? 'no environment set matches' : 'waiting for the project on a matching environment';
      }
    }

    for (const env of chosen) {
      const entry = entries.get(env)!;
      if (entry.phase !== 'Ready' || entry.projectId === null || !world.environment(env)?.ready) continue;
      const payload = upsertPayload(project, task, spec!, entry.projectId);
      const digest = hash(payload);
      const before = entry.tasks.find((t) => t.name === task);
      if (needsApply(before, previous.get(env)?.podUID, digest, world.environment(env)!, now)) {
        try {
          await deps.t3(env).call('scheduledTasks.upsert', payload);
          setPlacement(env, task, { name: task, appliedHash: digest, appliedAt: now.toISOString() });
        } catch (error) {
          message = `${env}: ${errorMessage(error)}`;
        }
      }
    }

    for (const env of holding.filter((n) => !chosen.includes(n))) {
      const pod = world.environment(env);
      if (!pod) {
        setPlacement(env, task, null);
        continue;
      }
      if (!pod.ready) continue; // removed once the pod is back
      try {
        await deps.t3(env).call('scheduledTasks.delete', { id: taskIdFor(project, task) });
        setPlacement(env, task, null);
      } catch (error) {
        message = `${env}: removal failed: ${errorMessage(error)}`;
      }
    }

    if (spec) {
      const placedOn = [...entries.values()].filter((e) => e.tasks.some((t) => t.name === task)).map((e) => e.name);
      summary.push({ name: task, environments: placedOn.sort(byName), message });
    }
  }
  return summary;
}

// ─── T3Project ───────────────────────────────────────────────────────────────

export class World {
  readonly sets: ReadonlyArray<PlacedSet>;
  private readonly envs = new Map<string, Environment>();
  constructor(sets: ReadonlyArray<PlacedSet>) {
    this.sets = sets;
    for (const set of sets) for (const env of set.environments ?? []) this.envs.set(env.name, env);
  }
  environment(name: string) {
    return this.envs.get(name);
  }
  labelsOf(set: string) {
    return this.sets.find((s) => s.name === set)?.labels ?? {};
  }
}

// Returns the project's status on the environments it targets, for the
// environment sets' readiness gates.
export async function reconcileProject(
  deps: Deps,
  cr: ProjectResource,
  world: World,
): Promise<ReadonlyArray<EnvironmentStatus>> {
  const previous = new Map((cr.status?.environments ?? []).map((e) => [e.name, e]));

  if (cr.metadata.deletionTimestamp) {
    if (!cr.metadata.finalizers?.includes(FINALIZER)) return [];
    const pending: EnvironmentStatus[] = [];
    for (const status of previous.values()) {
      const env = world.environment(status.name);
      if (!env) continue; // scaled away, or its set removed: nothing to clean up
      if (!env.ready) {
        pending.push({ ...status, phase: 'Waiting', message: 'pod not ready; removal waits for it' });
        continue;
      }
      try {
        await removeFromEnvironment(deps, cr, env, status);
      } catch (error) {
        pending.push({ ...status, phase: 'Error', message: `removal failed: ${errorMessage(error)}` });
      }
    }
    if (pending.length > 0) {
      await writeStatus(deps, 't3projects', cr, { phase: 'Deleting', message: null, environments: pending, tasks: [] });
    } else {
      await removeFinalizer(deps, cr);
    }
    return [];
  }

  await addFinalizer(deps, cr);
  const targets = world.sets
    .filter((set) => matches(cr.spec.environmentSetSelector, set.labels))
    .flatMap((set) => (set.environments ?? []).map((env) => ({ env, set: set.name })));
  const targeted = new Set(targets.map((t) => t.env.name));

  const entries = new Map<string, EnvironmentStatus>();
  for (const { env, set } of targets) {
    const before = previous.get(env.name);
    if (!env.ready) {
      entries.set(env.name, {
        ...(before ?? environmentStatus({ name: env.name, environmentSet: set, phase: 'Waiting' })),
        environmentSet: set,
        phase: 'Waiting',
        message: 'pod not ready',
      });
      continue;
    }
    try {
      entries.set(env.name, await syncProject(deps, cr, env, set, before));
    } catch (error) {
      entries.set(env.name, {
        ...(before ?? environmentStatus({ name: env.name, environmentSet: set, phase: 'Error' })),
        environmentSet: set,
        podUID: env.uid,
        phase: 'Error',
        message: errorMessage(error),
      });
    }
  }

  // Environments the selector no longer reaches lose the project. One whose
  // pod is gone (scaled away) is simply forgotten: its volumes, and the
  // project on them, come back with it.
  for (const status of previous.values()) {
    if (targeted.has(status.name)) continue;
    const env = world.environment(status.name);
    if (!env) continue;
    if (!env.ready) {
      entries.set(status.name, { ...status, phase: 'Waiting', message: 'no longer selected; removal waits for the pod' });
      continue;
    }
    try {
      await removeFromEnvironment(deps, cr, env, status);
    } catch (error) {
      entries.set(status.name, { ...status, phase: 'Error', message: `removal failed: ${errorMessage(error)}` });
    }
  }

  const tasks = await placeTasks(deps, cr, world, targeted, entries, previous);
  const environments = [...entries.values()].sort((a, b) => byName(a.name, b.name));
  const current = environments.filter((e) => targeted.has(e.name));
  await writeStatus(deps, 't3projects', cr, {
    phase: aggregatePhase(current),
    message: targets.length === 0 ? 'no environment set matches environmentSetSelector' : null,
    environments,
    tasks,
  });
  return current;
}

// ─── T3EnvironmentSet ────────────────────────────────────────────────────────

export interface Placed {
  readonly project: string;
  readonly phase: Phase;
  readonly cloningSince: string | null;
}

// Whether a project placed on an environment holds its content gate: while
// it is on its way (Waiting, or Cloning for up to CLONE_GATE_MS). An Error
// does not: it is in status for a person, and holding the gate on it would
// stall every later rollout.
export function holdsGate(p: Placed, now: Date): boolean {
  if (p.phase === 'Waiting') return true;
  if (p.phase !== 'Cloning') return false;
  return p.cloningSince === null || now.getTime() - Date.parse(p.cloningSince) < CLONE_GATE_MS;
}

// Sets each environment's content-ready gate and the set's status.
export async function reconcileEnvironmentSet(
  deps: Deps,
  cr: EnvironmentSetResource,
  set: PlacedSet,
  projects: ReadonlyMap<string, ReadonlyArray<Placed>>,
): Promise<void> {
  if (set.environments === null) {
    await writeStatus(deps, 't3environmentsets', cr, {
      phase: 'Error',
      message: `StatefulSet ${cr.spec.statefulSet} not found`,
      environments: [],
    });
    return;
  }
  const now = deps.now();
  const environments = [];
  for (const env of set.environments) {
    const placed = projects.get(env.name) ?? [];
    const pending = placed.filter((p) => holdsGate(p, now)).map((p) => p.project);
    const contentReady = pending.length === 0;
    if (env.contentReady !== contentReady) {
      await deps.kube.setContentReady(
        env.name,
        contentReady,
        contentReady ? `${placed.length} project(s) in place` : `waiting for ${pending.join(', ')}`,
      );
    }
    environments.push({
      name: env.name,
      ready: env.ready,
      contentReady,
      projects: placed.map((p) => ({ name: p.project, phase: p.phase })),
    });
  }
  await writeStatus(deps, 't3environmentsets', cr, {
    phase: environments.every((e) => e.ready && e.contentReady) ? 'Ready' : 'Progressing',
    message: null,
    environments,
  });
}
