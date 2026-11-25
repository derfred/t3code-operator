// Level-triggered reconciliation. An environment is one t3 pod; an
// environment set is the StatefulSet that makes a group of them. A T3Project
// selects sets by label and is placed on every environment of every set it
// selects; its tasks (t3 scheduled tasks) are placed on one, or each, of
// those. t3 itself runs the tasks: the operator only decides which
// environments hold their definitions. See docs/design.md.

import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { AuthSpec } from './auth.ts';
import type { Clones } from './clones.ts';
import type { Environment, Kube, Resource } from './kube.ts';
import { matches, type LabelSelector } from './selector.ts';
import type { T3, T3Project } from './t3.ts';

export const FINALIZER = 't3code.derfred.com/cleanup';
// Re-apply unchanged specs this often, to repair edits made in the t3 UI.
export const RESYNC_MS = 60 * 60 * 1000;
// A clone holds the readiness gate this long at most. One that fails turns
// Error, which doesn't hold it; this bounds one that never finishes.
export const CLONE_GATE_MS = 15 * 60 * 1000;
// A clone that failed is tried again, from the same repository, this long
// after it failed: a network outage, or a key not yet in place, passes.
export const CLONE_RETRY_MS = 5 * 60 * 1000;

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

// One repository of a multi-repository project (spec.repositories).
export interface RepositorySpec {
  readonly url: string;
  // Relative: inside the project folder, where t3 finds it by itself.
  // Absolute, outside the project folder: added to the project as a tracked
  // folder. Default: the repository's name, inside the project folder.
  readonly path?: string;
}

export interface ProjectSpec {
  // Exactly one of the two. repository: the project folder is its clone.
  // repositories: the project folder is a plain folder, and each one is
  // cloned into it (or elsewhere, and tracked).
  readonly repository?: string;
  readonly repositories?: Readonly<Record<string, RepositorySpec>>;
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
  // The repository the latest clone started from, to tell a clone of an
  // old URL from one of the current.
  readonly repository: string | null;
  readonly tasks: ReadonlyArray<TaskPlacement>;
  // Multi-repository projects only: each repository on this environment,
  // and the folders outside the project folder the operator tracks in it.
  readonly repositories?: ReadonlyArray<RepositoryStatus>;
  readonly trackedFolders?: ReadonlyArray<string>;
}

export interface RepositoryStatus {
  readonly name: string;
  readonly path: string;
  readonly phase: Phase;
  readonly message: string | null;
  // The URL it was cloned from.
  readonly repository: string | null;
  // Cloning: since when. Error: when the clone failed.
  readonly since: string | null;
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
export type EnvironmentSetResource = Resource<{ readonly statefulSet: string; readonly auth?: AuthSpec }, unknown>;

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
  // A connection of its own, for a call that outlives the pass (a clone).
  readonly connect: (environment: string) => T3;
  readonly clones: Clones;
  readonly now: () => Date;
}

export const projectIdFor = (name: string) => `k8s-${name}`;
// The ids the operator gives a project: projectIdFor, or a fresh one after
// it (withFreshId).
const isOwnId = (name: string, id: string) => id === projectIdFor(name) || new RegExp(`^${projectIdFor(name)}-[0-9a-f]{8}$`).test(id);
export const taskIdFor = (project: string, task: string) => `k8s-${project}-${task}`;
export const workspaceRootFor = (cr: ProjectResource) => cr.spec.path ?? `/workspace/${cr.metadata.name}`;

// The single repository of a project, which spec.repositories does not have.
function repositoryOf(cr: ProjectResource): string {
  if (cr.spec.repository === undefined) throw new Error('spec needs repository or repositories');
  return cr.spec.repository;
}

export interface ResolvedRepository {
  readonly name: string;
  readonly url: string;
  // Absolute.
  readonly path: string;
  // Outside the project folder: tracked in the project, as t3 doesn't find it.
  readonly tracked: boolean;
}

const within = (parent: string, child: string) => {
  const relative = posix.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith('../'));
};

// spec.repositories with their paths resolved, by name; null for a
// single-repository project. Throws on a spec t3 couldn't follow.
export function repositoriesOf(cr: ProjectResource): ReadonlyArray<ResolvedRepository> | null {
  if (cr.spec.repositories === undefined) return null;
  if (cr.spec.repository !== undefined) throw new Error('spec has both repository and repositories; give one');
  const root = posix.normalize(workspaceRootFor(cr));
  const resolved = Object.entries(cr.spec.repositories)
    .sort(([a], [b]) => byName(a, b))
    .map(([name, spec]) => {
      const given = spec.path ?? name;
      const path = posix.isAbsolute(given) ? posix.normalize(given) : posix.join(root, given);
      if (path === root) throw new Error(`repository ${name}: ${path} is the project folder itself`);
      if (within(path, root)) throw new Error(`repository ${name}: ${path} contains the project folder ${root}`);
      const inside = within(root, path);
      // t3 looks one level down, and one more inside folders that aren't
      // repositories themselves.
      if (inside && posix.relative(root, path).split('/').length > 2) {
        throw new Error(`repository ${name}: ${path} is more than two levels inside ${root}, deeper than t3 looks for repositories`);
      }
      return { name, url: spec.url, path, tracked: !inside };
    });
  for (const [i, repo] of resolved.entries()) {
    const other = resolved.slice(0, i).find((r) => within(r.path, repo.path) || within(repo.path, r.path));
    if (other) throw new Error(`repositories ${other.name} and ${repo.name}: ${other.path} and ${repo.path} overlap`);
  }
  return resolved;
}

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
    repository: null,
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

// Starts a clone; resolves to the id t3 registered the project under.
async function startClone(t3: T3, cr: ProjectResource, projectId: string, now: Date): Promise<string> {
  const started = (await t3.call('projectClone.start', {
    projectId,
    title: cr.spec.title ?? cr.metadata.name,
    createdAt: now.toISOString(),
    remoteUrl: repositoryOf(cr),
    destinationPath: workspaceRootFor(cr),
  })) as { projectId?: string } | undefined;
  return started?.projectId ?? projectId;
}

// t3 never takes a deleted project's id again, and doesn't always say so: a
// clone started under one registers no project (t3 takes its create command,
// whose id derives from the project's, as done already), clones anyway, and
// leaves the checkout without a project. Nor does t3 list deleted projects.
// So the operator picks a fresh id itself whenever it knows the plain one is
// used: t3 lists it, or a failed clone is started over. The status records the id, and a lost status finds it by path. A
// project.create under a used id is refused (invalid_command; "cannot be
// created twice" in older t3), and gets a fresh id too.
const freshId = (name: string) => `${projectIdFor(name)}-${randomUUID().slice(0, 8)}`;
async function withFreshId<T>(
  name: string,
  known: ReadonlyArray<Pick<T3Project, 'id'>>,
  attempt: (projectId: string) => Promise<T>,
): Promise<T> {
  if (known.some((p) => p.id === projectIdFor(name))) return attempt(freshId(name));
  try {
    return await attempt(projectIdFor(name));
  } catch (error) {
    if (!/cannot be created twice|invalid_command/i.test(errorMessage(error))) throw error;
    return attempt(freshId(name));
  }
}

// t3's record of a clone it ran for the project, while it keeps one: a
// running or failed clone until the project goes, a finished one briefly.
export interface CloneSnapshot {
  readonly projectId: string;
  readonly remoteUrl: string;
  readonly phase: 'running' | 'done' | 'failed' | 'cancelled';
  readonly error: string | null;
  readonly endedAt: string | null;
}

async function cloneOf(t3: T3, projectId: string): Promise<CloneSnapshot | undefined> {
  const clones = (await t3.first('subscribeProjectClones', {})) as ReadonlyArray<CloneSnapshot> | undefined;
  return clones?.find((c) => c.projectId === projectId);
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
  const repositories = repositoriesOf(cr);
  const carried = {
    name: env.name,
    environmentSet: set,
    podUID: env.uid,
    managesSettings: previous?.managesSettings ?? false,
    tasks: previous?.tasks ?? [],
    ...(repositories === null ? {} : { trackedFolders: previous?.trackedFolders ?? [] }),
  };
  const cloningSince = previous?.phase === 'Cloning' && previous.cloningSince ? previous.cloningSince : now.toISOString();
  const cloning = (projectId: string, repository: string, since = cloningSince) =>
    environmentStatus({
      ...carried,
      phase: 'Cloning',
      cloningSince: since,
      projectId,
      repository,
      message: `cloning ${repository} into ${root}`,
    });

  // Deleted projects included: their ids are taken (withFreshId).
  const known = await t3.listProjects();
  const live = known.filter((p) => p.deletedAt === null);
  // Prefer the id this environment already uses; else adopt a project
  // registered at the same path by hand, so it keeps its threads.
  let project: Pick<T3Project, 'id'> | undefined =
    live.find((p) => p.id === (previous?.projectId ?? projectIdFor(name))) ?? live.find((p) => p.workspaceRoot === root);

  const create = (createWorkspaceRootIfMissing: boolean) =>
    withFreshId(name, known, async (id) => {
      await t3.mutateProject({
        type: 'project.create',
        commandId: randomUUID(),
        projectId: id,
        title,
        workspaceRoot: root,
        ...(createWorkspaceRootIfMissing ? { createWorkspaceRootIfMissing } : {}),
      });
      return id;
    });

  if (!project && repositories !== null) {
    // A plain folder: registered as it is, the repositories cloned into it.
    project = { id: await create(true) };
  } else if (!project) {
    try {
      const started = await withFreshId(name, known, (id) => startClone(t3, cr, id, now));
      return cloning(started, repositoryOf(cr));
    } catch (error) {
      // A checkout already on disk is registered as it is, not re-cloned.
      if (!/not empty/i.test(errorMessage(error))) throw error;
      project = { id: await create(false) };
    }
  }
  const projectId = project.id;

  let repositoryStatuses: ReadonlyArray<RepositoryStatus> | undefined;
  if (repositories !== null) {
    repositoryStatuses = await syncRepositories(deps, env, repositories, previous);
    const failed = repositoryStatuses.filter((r) => r.phase === 'Error');
    const underway = repositoryStatuses.filter((r) => r.phase === 'Cloning');
    if (failed.length > 0 || underway.length > 0) {
      return environmentStatus({
        ...carried,
        phase: failed.length > 0 ? 'Error' : 'Cloning',
        projectId,
        repositories: repositoryStatuses,
        cloningSince: underway.map((r) => r.since!).sort()[0] ?? null,
        message:
          failed.length > 0
            ? failed.map((r) => r.message).join('; ')
            : `cloning ${underway.map((r) => r.name).join(', ')}`,
      });
    }
  } else if (previous?.phase !== 'Ready' || previous.projectId !== projectId) {
    // projectClone.start registers the project before git runs, so an
    // existing project can still be an unfinished or failed clone. Check
    // until it has files once; after that it is Ready and the check is
    // skipped.
    // directoryPath '' reads the folder as it is now. Without it t3 answers
    // from its search index for the path, which, made while a failed clone
    // left the folder empty, stays empty after t3 deletes the folder and the
    // new clone fills it.
    const listing = (await t3.call('projects.listEntries', { cwd: root, directoryPath: '' })) as {
      entries: ReadonlyArray<unknown>;
    };
    if (listing.entries.length === 0) {
      const clone = await cloneOf(t3, projectId);
      if (clone?.phase === 'failed' || clone?.phase === 'cancelled') {
        return failedClone(deps, cr, t3, clone, previous, cloning, carried);
      }
      // Empty to the listing, which skips .git, is also a clone under way:
      // git has written .git but checked nothing out yet. t3 checks the
      // destination before it looks for a running clone, so that start
      // fails "not empty" rather than "in progress". Both mean: still
      // cloning.
      try {
        await startClone(t3, cr, projectId, now);
      } catch (error) {
        if (!/in progress|not empty/i.test(errorMessage(error))) throw error;
      }
      return cloning(projectId, previous?.repository ?? repositoryOf(cr));
    }
  }

  // Repositories outside the project folder are tracked in it. The operator
  // adds and removes only those, by path, so folders added in t3 stay.
  const tracked = (repositories ?? []).filter((r) => r.tracked);
  const untrack = (previous?.trackedFolders ?? []).filter((path) => !tracked.some((r) => r.path === path));
  const digest = hash({
    title,
    project: cr.spec.project ?? {},
    settings: cr.spec.settings ?? null,
    ...(repositories === null ? {} : { tracked: tracked.map((r) => [r.name, r.path]) }),
  });
  let applied = { appliedHash: previous?.appliedHash ?? null, appliedAt: previous?.appliedAt ?? null };
  let managesSettings = carried.managesSettings;
  let trackedFolders = carried.trackedFolders;
  if (needsApply(previous, previous?.podUID, digest, env, now)) {
    await t3.mutateProject({
      // Unarchive a project an earlier Archive left behind.
      archived: false,
      ...cr.spec.project,
      type: 'project.update',
      commandId: randomUUID(),
      projectId,
      title,
      ...(tracked.length > 0 ? { trackFolders: tracked.map((r) => ({ path: r.path, name: r.name })) } : {}),
      ...(untrack.length > 0 ? { untrackFolders: untrack } : {}),
    });
    if (repositories !== null) trackedFolders = tracked.map((r) => r.path);
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
    ...(repositories === null ? {} : { repositories: repositoryStatuses, trackedFolders }),
    message: isOwnId(name, projectId) ? null : `adopted existing project ${projectId}`,
  });
}

// Clones each repository of a multi-repository project that this pod doesn't
// have yet, and reports where each stands. A repository is Ready once its
// folder holds files: a clone that finished, or files that were there
// already (a restarted pod, or a checkout made by hand), which are kept as
// they are. A failed clone is retried after CLONE_RETRY_MS, or at once for a
// changed URL or a restarted pod.
async function syncRepositories(
  deps: Deps,
  env: Environment,
  repositories: ReadonlyArray<ResolvedRepository>,
  previous: EnvironmentStatus | undefined,
): Promise<ReadonlyArray<RepositoryStatus>> {
  const now = deps.now();
  const statuses: RepositoryStatus[] = [];
  for (const repo of repositories) {
    const status = (fields: Pick<RepositoryStatus, 'phase' | 'message' | 'repository' | 'since'>): RepositoryStatus => ({
      name: repo.name,
      path: repo.path,
      ...fields,
    });
    const before = previous?.repositories?.find((r) => r.name === repo.name && r.path === repo.path);
    if (before?.phase === 'Ready' && previous?.podUID === env.uid) {
      // A changed URL doesn't replace a checkout: its files stay.
      const message =
        before.repository !== null && before.repository !== repo.url
          ? `checked out from ${before.repository}; a changed url is not cloned again`
          : before.message;
      statuses.push(status({ phase: 'Ready', message, repository: before.repository, since: null }));
      continue;
    }
    let job = deps.clones.get(env.name, repo.path);
    const retry =
      job !== undefined &&
      (job.podUID !== env.uid ||
        (job.phase === 'failed' && (job.remoteUrl !== repo.url || now.getTime() - Date.parse(job.endedAt ?? '') >= CLONE_RETRY_MS)));
    if (job === undefined || retry) {
      job = await deps.clones.start(
        { environment: env.name, podUID: env.uid, destinationPath: repo.path, remoteUrl: repo.url },
        deps.connect(env.name),
      );
    }
    if (job.phase === 'running') {
      statuses.push(
        status({ phase: 'Cloning', message: `cloning ${job.remoteUrl} into ${repo.path}`, repository: job.remoteUrl, since: job.startedAt }),
      );
    } else if (job.phase === 'done') {
      // Recorded in status from here on; a later pod checks its folder anew.
      deps.clones.forget(env.name, repo.path);
      statuses.push(
        status({
          phase: 'Ready',
          // Files there already, which a restarted pod finds of its own
          // clone: said only of files the operator didn't clone.
          message: !job.existing ? null : before === undefined ? `kept the files already in ${repo.path}` : before.message,
          repository: job.existing ? (before?.repository ?? null) : job.remoteUrl,
          since: null,
        }),
      );
    } else {
      statuses.push(
        status({
          phase: 'Error',
          message: `clone of ${job.remoteUrl} into ${repo.path} failed: ${job.error ?? 'no detail'}`,
          repository: job.remoteUrl,
          since: job.endedAt,
        }),
      );
    }
  }
  return statuses;
}

// A clone t3 gave up on: Error with git's message, which doesn't hold the
// readiness gate. Retried from the same repository after CLONE_RETRY_MS. A
// changed repository can't be retried (t3 would clone the old one again),
// so the project, which has no files yet, is deleted, and with it the failed
// clone and its folder, and the new repository cloned under a fresh id.
async function failedClone(
  deps: Deps,
  cr: ProjectResource,
  t3: T3,
  clone: CloneSnapshot,
  previous: EnvironmentStatus | undefined,
  cloning: (projectId: string, repository: string, since?: string) => EnvironmentStatus,
  carried: Pick<EnvironmentStatus, 'name' | 'environmentSet' | 'podUID' | 'managesSettings' | 'tasks'>,
): Promise<EnvironmentStatus> {
  const now = deps.now();
  const repository = repositoryOf(cr);
  const from = previous?.repository ?? clone.remoteUrl;
  if (from !== repository) {
    await t3.mutateProject({ type: 'project.delete', commandId: randomUUID(), projectId: clone.projectId, force: true });
    // The plain id is used by now: it was this clone's, or one before it.
    const started = await startClone(t3, cr, freshId(cr.metadata.name), now);
    return cloning(started, repository, now.toISOString());
  }
  const failedAt = clone.endedAt === null ? 0 : Date.parse(clone.endedAt);
  if (now.getTime() - failedAt >= CLONE_RETRY_MS) {
    await t3.call('projectClone.retry', { projectId: clone.projectId });
    return cloning(clone.projectId, from, now.toISOString());
  }
  return environmentStatus({
    ...carried,
    phase: 'Error',
    projectId: clone.projectId,
    repository: from,
    message: `clone of ${from} ${clone.phase === 'cancelled' ? 'cancelled' : 'failed'}: ${clone.error ?? 'no detail'}`,
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
