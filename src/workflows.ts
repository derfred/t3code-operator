// T3Workflow: a t3 workflow file (k8s-<name>.ts in the T3 home's workflows
// folder), placed on one, or each, environment of the T3EnvironmentSets it
// selects, as a task is. t3 runs the workflow; the operator only decides
// which environments hold its file, and turns t3's workflows on where they
// do (workflowsEnabled). See docs/design.md, Workflows.
//
// Level-triggered like the rest: each pass reads t3's definitions and saves
// the file wherever it is missing or differs, so a file deleted or edited in
// the t3 UI comes back on the next pass.

import type { Resource } from './kube.ts';
import {
  addFinalizer,
  byName,
  choosePlacement,
  errorMessage,
  FINALIZER,
  hash,
  removeFinalizer,
  writeStatus,
  type Deps,
  type Placement,
  type World,
} from './reconcile.ts';
import { matches, type LabelSelector } from './selector.ts';

export const PLURAL = 't3workflows';

export interface WorkflowSpec {
  // The file's contents, or where to read them: exactly one of the two.
  readonly source?: string;
  readonly sourceFrom?: { readonly configMapKeyRef: { readonly name: string; readonly key: string } };
  readonly environmentSetSelector?: LabelSelector;
  readonly placement?: Placement;
  // T3Projects that must be Ready on an environment before the workflow goes
  // there: an agent step pointed at a folder t3 has no project for pauses.
  readonly projects?: ReadonlyArray<string>;
  readonly deletionPolicy?: 'Delete' | 'Retain';
}

export type WorkflowPhase = 'Waiting' | 'Ready' | 'Degraded' | 'Removing' | 'Error';

// What t3 says is wrong with a definition: a load error at a line, or why a
// save or delete was refused (a version removed while runs of it are open).
export interface Problem {
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
}

export interface WorkflowEnvironmentStatus {
  readonly name: string;
  readonly environmentSet: string;
  readonly phase: WorkflowPhase;
  readonly message: string | null;
  readonly podUID: string | null;
  // The hash of the file as it is on the environment: the spec's while it is
  // applied, an older one's while t3 refuses the new.
  readonly sourceHash: string | null;
  // What the file defines, as t3 loaded it: name@version.
  readonly workflows: ReadonlyArray<string>;
  readonly problems: ReadonlyArray<Problem>;
  // Runs of those workflows that have not ended, and of them, those that
  // wait on a person: open questions and paused runs.
  readonly activeRuns: number;
  readonly needsYou: number;
}

export interface Condition {
  readonly type: string;
  readonly status: 'True' | 'False' | 'Unknown';
  readonly reason: string;
  readonly message: string;
  readonly observedGeneration: number | null;
  readonly lastTransitionTime: string;
}

export interface WorkflowStatus {
  readonly observedGeneration?: number | null;
  readonly phase?: string;
  readonly message?: string | null;
  readonly sourceHash?: string | null;
  readonly conditions?: ReadonlyArray<Condition>;
  readonly environments?: ReadonlyArray<WorkflowEnvironmentStatus>;
}

export type WorkflowResource = Resource<WorkflowSpec, WorkflowStatus>;

export const workflowFileFor = (name: string) => `k8s-${name}.ts`;

// t3's answers, as far as the operator reads them.
interface DefinitionFile {
  readonly name: string;
  readonly source: string;
  readonly workflows: ReadonlyArray<string>;
  readonly problems: ReadonlyArray<Problem>;
}
interface Definitions {
  readonly single: boolean;
  readonly files: ReadonlyArray<DefinitionFile>;
  readonly problems: ReadonlyArray<Problem>;
}
interface ChangeResult {
  readonly changed: boolean;
  readonly problems: ReadonlyArray<Problem>;
}
interface RunsSnapshot {
  readonly runs: ReadonlyArray<{ readonly runId: string; readonly workflow: string; readonly status: string }>;
  readonly questions: ReadonlyArray<{ readonly runId: string }>;
}

const UNFINISHED = new Set(['running', 'waiting', 'paused']);

export const problemText = (p: Problem) =>
  `${p.file ? `${p.file}${p.line ? `:${p.line}` : ''}: ` : ''}${p.message}`;

// ─── t3's workflows on each environment, for one pass ───────────────────────

// What a pass learns of t3's workflows on an environment, asked once, and
// whether the operator turned them on there. `previous` is that record as the
// T3EnvironmentSets' status keeps it: environment -> managesWorkflows.
export class WorkflowHosts {
  readonly #deps: Deps;
  readonly #previous: ReadonlyMap<string, boolean>;
  readonly #managed = new Map<string, boolean>();
  readonly #enabled = new Map<string, Promise<boolean>>();
  readonly #enabling = new Map<string, Promise<void>>();
  readonly #definitions = new Map<string, Promise<Definitions>>();
  readonly #runs = new Map<string, Promise<RunsSnapshot>>();

  constructor(deps: Deps, previous: ReadonlyMap<string, boolean>) {
    this.#deps = deps;
    this.#previous = previous;
  }

  // Whether the operator turned workflows on in this environment (and so
  // turns them off again once it holds none there).
  manages(env: string): boolean {
    return this.#managed.get(env) ?? this.#previous.get(env) ?? false;
  }

  #isEnabled(env: string): Promise<boolean> {
    let enabled = this.#enabled.get(env);
    if (!enabled) {
      enabled = this.#deps
        .t3(env)
        .call('server.getConfig', {})
        .then((config: any) => config?.settings?.workflowsEnabled === true);
      this.#enabled.set(env, enabled);
    }
    return enabled;
  }

  // Turns workflows on, unless they are. t3 refuses to save a definition
  // while they are off, and lists no files then.
  enable(env: string): Promise<void> {
    let enabling = this.#enabling.get(env);
    if (!enabling) {
      enabling = (async () => {
        if (await this.#isEnabled(env)) {
          if (!this.#managed.has(env)) this.#managed.set(env, this.#previous.get(env) ?? false);
          return;
        }
        await this.#deps.t3(env).call('server.updateSettings', { patch: { workflowsEnabled: true } });
        this.#enabled.set(env, Promise.resolve(true));
        this.#definitions.delete(env);
        this.#managed.set(env, true);
      })();
      // A failure is the caller's; the next caller asks again.
      enabling.catch(() => this.#enabling.delete(env));
      this.#enabling.set(env, enabling);
    }
    return enabling;
  }

  definitions(env: string): Promise<Definitions> {
    let definitions = this.#definitions.get(env);
    if (!definitions) {
      definitions = this.#deps.t3(env).call('workflows.getDefinition', {}) as Promise<Definitions>;
      definitions.catch(() => this.#definitions.delete(env));
      this.#definitions.set(env, definitions);
    }
    return definitions;
  }

  async save(env: string, name: string, source: string): Promise<ChangeResult> {
    this.#definitions.delete(env);
    return (await this.#deps.t3(env).call('workflows.saveDefinition', { name, source })) as ChangeResult;
  }

  async remove(env: string, name: string): Promise<ChangeResult> {
    this.#definitions.delete(env);
    return (await this.#deps.t3(env).call('workflows.deleteDefinition', { name })) as ChangeResult;
  }

  runs(env: string): Promise<RunsSnapshot> {
    let runs = this.#runs.get(env);
    if (!runs) {
      // A stream: its first value is the whole list.
      runs = this.#deps.t3(env).first('workflows.subscribe', {}) as Promise<RunsSnapshot>;
      runs.catch(() => this.#runs.delete(env));
      this.#runs.set(env, runs);
    }
    return runs;
  }

  // Turns workflows off again where the operator turned them on and holds no
  // workflow any more, once no file is left there: a file someone else put
  // there (or one a Retain left behind) keeps them on, and then they are no
  // longer the operator's to turn off. `holders` are the environments that
  // still hold, or are still removing, an operator workflow.
  async release(world: World, holders: ReadonlySet<string>): Promise<void> {
    const envs = new Set([...this.#previous.keys(), ...this.#managed.keys()]);
    for (const env of envs) {
      if (!this.manages(env) || holders.has(env)) continue;
      const pod = world.environment(env);
      if (!pod) {
        // Gone, and its record with it; a new pod of the name starts over.
        this.#managed.set(env, false);
        continue;
      }
      if (!pod.ready) continue; // kept, and released once the pod is back
      try {
        if (!(await this.#isEnabled(env))) {
          this.#managed.set(env, false);
          continue;
        }
        if ((await this.definitions(env)).files.length === 0) {
          await this.#deps.t3(env).call('server.updateSettings', { patch: { workflowsEnabled: false } });
        }
        this.#managed.set(env, false);
      } catch {
        // Kept: tried again on the next pass.
      }
    }
  }
}

// ─── one T3Workflow ──────────────────────────────────────────────────────────

async function resolveSource(deps: Deps, spec: WorkflowSpec): Promise<string> {
  const ref = spec.sourceFrom?.configMapKeyRef;
  if (typeof spec.source === 'string') {
    if (ref) throw new Error('set spec.source or spec.sourceFrom, not both');
    return spec.source;
  }
  if (!ref) throw new Error('spec.source or spec.sourceFrom.configMapKeyRef is required');
  const data = await deps.kube.configMapData(ref.name);
  if (data === null) throw new Error(`waiting for ConfigMap ${ref.name}`);
  const value = data[ref.key];
  if (value === undefined) throw new Error(`ConfigMap ${ref.name} has no key ${ref.key}`);
  return value;
}

function environmentStatus(
  fields: Partial<WorkflowEnvironmentStatus> & Pick<WorkflowEnvironmentStatus, 'name' | 'environmentSet' | 'phase'>,
): WorkflowEnvironmentStatus {
  return {
    message: null,
    podUID: null,
    sourceHash: null,
    workflows: [],
    problems: [],
    activeRuns: 0,
    needsYou: 0,
    ...fields,
  };
}

// Puts the file on one environment, unless it is there as it should be, and
// reads back what t3 made of it.
async function syncWorkflow(
  hosts: WorkflowHosts,
  file: string,
  source: string,
  env: string,
  set: string,
  podUID: string,
): Promise<WorkflowEnvironmentStatus> {
  await hosts.enable(env);
  let definitions = await hosts.definitions(env);
  if (definitions.single) {
    return environmentStatus({
      name: env,
      environmentSet: set,
      podUID,
      phase: 'Error',
      message: `t3 here reads its workflows from one file (T3CODE_WORKFLOWS), so ${file} cannot be added beside it`,
    });
  }
  let current = definitions.files.find((f) => f.name === file);
  const problems: Problem[] = [];
  if (current?.source !== source) {
    // t3 checks the file before it writes it: a file that doesn't load, or
    // that removes a version with runs still open, is refused, and the one
    // on disk keeps running.
    const result = await hosts.save(env, file, source);
    problems.push(...result.problems);
    definitions = await hosts.definitions(env);
    current = definitions.files.find((f) => f.name === file);
  }
  problems.push(...(current?.problems ?? []), ...definitions.problems.filter((p) => p.file === file));

  const names = new Set((current?.workflows ?? []).map((w) => w.slice(0, w.lastIndexOf('@'))));
  const runs = await hosts.runs(env);
  const active = runs.runs.filter((r) => names.has(r.workflow) && UNFINISHED.has(r.status));
  const activeIds = new Set(active.map((r) => r.runId));
  const needsYou =
    runs.questions.filter((q) => activeIds.has(q.runId)).length + active.filter((r) => r.status === 'paused').length;

  const applied = current?.source === source;
  const message =
    problems.length === 0
      ? null
      : applied
        ? problemText(problems[0]!)
        : `not applied, ${current ? 'the previous file runs' : 'nothing runs'}: ${problemText(problems[0]!)}`;
  return environmentStatus({
    name: env,
    environmentSet: set,
    podUID,
    phase: problems.length > 0 ? 'Degraded' : 'Ready',
    message,
    sourceHash: current ? hash(current.source) : null,
    workflows: [...(current?.workflows ?? [])].sort(byName),
    problems,
    activeRuns: active.length,
    needsYou,
  });
}

// Takes the file off an environment. Its status entry while that is not done
// yet, or null once it is: t3 refuses to delete a version whose runs have not
// ended, so the entry stays, as Removing, until they have.
async function removeWorkflow(
  hosts: WorkflowHosts,
  world: World,
  file: string,
  status: WorkflowEnvironmentStatus,
): Promise<WorkflowEnvironmentStatus | null> {
  const pod = world.environment(status.name);
  if (!pod) return null; // scaled away, or its set removed
  if (!pod.ready) return { ...status, phase: 'Removing', message: 'removal waits for the pod' };
  try {
    // Off, t3 lists no files and deletes none: the file would come back once
    // they are on. On for the removal, and off again after (release).
    await hosts.enable(status.name);
    if (!(await hosts.definitions(status.name)).files.some((f) => f.name === file)) return null;
    const result = await hosts.remove(status.name, file);
    if (result.changed) return null;
    return {
      ...status,
      phase: 'Removing',
      message: result.problems.length > 0 ? `not removed yet: ${problemText(result.problems[0]!)}` : 'not removed yet',
      problems: result.problems,
    };
  } catch (error) {
    return { ...status, phase: 'Removing', message: `removal failed: ${errorMessage(error)}` };
  }
}

function aggregate(entries: ReadonlyArray<WorkflowEnvironmentStatus>): WorkflowPhase | 'Progressing' {
  const phases = entries.map((e) => e.phase);
  if (phases.includes('Error')) return 'Error';
  if (phases.includes('Degraded')) return 'Degraded';
  if (phases.length > 0 && phases.every((p) => p === 'Ready')) return 'Ready';
  return 'Progressing';
}

// Ready, for kubectl wait and Flux's health checks (kstatus): True once the
// file is in place and loads on every environment it is placed on. Its
// transition time moves only when its status does, so a settled status is
// not rewritten.
export function readyCondition(
  previous: ReadonlyArray<Condition> | undefined,
  phase: string,
  message: string | null,
  generation: number | null,
  now: Date,
): Condition {
  const status = phase === 'Ready' ? 'True' : 'False';
  const before = previous?.find((c) => c.type === 'Ready');
  return {
    type: 'Ready',
    status,
    reason: phase,
    message: message ?? (status === 'True' ? 'the workflow file is in place on its environments' : phase),
    observedGeneration: generation,
    lastTransitionTime: before?.status === status ? before.lastTransitionTime : now.toISOString(),
  };
}

// Reconciles one T3Workflow. Returns the environments that hold its file, or
// are still taking it off, after this pass (for WorkflowHosts.release).
// `projectReady` says whether a T3Project is Ready on an environment, as this
// pass left it.
export async function reconcileWorkflow(
  deps: Deps,
  cr: WorkflowResource,
  world: World,
  hosts: WorkflowHosts,
  projectReady: (env: string, project: string) => boolean,
): Promise<ReadonlyArray<string>> {
  const name = cr.metadata.name;
  const file = workflowFileFor(name);
  const previous = new Map((cr.status?.environments ?? []).map((e) => [e.name, e]));
  const generation = cr.metadata.generation ?? null;
  const write = (phase: string, message: string | null, environments: ReadonlyArray<WorkflowEnvironmentStatus>, sourceHash: string | null) =>
    writeStatus(deps, PLURAL, cr, {
      phase,
      message,
      sourceHash,
      conditions: [readyCondition(cr.status?.conditions, phase, message, generation, deps.now())],
      environments: [...environments].sort((a, b) => byName(a.name, b.name)),
    });

  if (cr.metadata.deletionTimestamp) {
    if (!cr.metadata.finalizers?.includes(FINALIZER)) return [];
    const pending: WorkflowEnvironmentStatus[] = [];
    if ((cr.spec.deletionPolicy ?? 'Delete') === 'Delete') {
      for (const status of previous.values()) {
        const left = await removeWorkflow(hosts, world, file, status);
        if (left) pending.push(left);
      }
    }
    if (pending.length > 0) {
      await write('Deleting', `${pending[0]!.name}: ${pending[0]!.message}`, pending, cr.status?.sourceHash ?? null);
      return pending.map((e) => e.name);
    }
    await removeFinalizer(deps, cr, PLURAL);
    return [];
  }

  await addFinalizer(deps, cr, PLURAL);

  let source: string;
  try {
    source = await resolveSource(deps, cr.spec);
  } catch (error) {
    // No source is no reason to take the file away: it stays as it is
    // wherever it is, until there is one again.
    await write('Error', errorMessage(error), [...previous.values()], cr.status?.sourceHash ?? null);
    return [...previous.keys()];
  }

  const targets = world.sets
    .filter((set) => matches(cr.spec.environmentSetSelector, set.labels))
    .flatMap((set) => (set.environments ?? []).map((env) => ({ env, set: set.name })));
  const setOf = new Map(targets.map((t) => [t.env.name, t.set]));
  const candidates = targets.map((t) => t.env.name);
  const projects = cr.spec.projects ?? [];
  const eligible = targets
    .filter((t) => t.env.ready && projects.every((p) => projectReady(t.env.name, p)))
    .map((t) => t.env.name);
  // An environment still taking the file off (runs open after a move) no
  // longer holds it: it doesn't get it back for being a candidate again.
  const holding = [...previous.values()].filter((e) => e.phase !== 'Removing').map((e) => e.name);
  const chosen = choosePlacement(name, cr.spec.placement, candidates, eligible, holding);

  const entries: WorkflowEnvironmentStatus[] = [];
  for (const envName of chosen) {
    const env = world.environment(envName)!;
    const set = setOf.get(envName)!;
    const before = previous.get(envName);
    if (!env.ready) {
      entries.push({
        ...(before ?? environmentStatus({ name: envName, environmentSet: set, phase: 'Waiting' })),
        environmentSet: set,
        phase: 'Waiting',
        message: 'pod not ready',
      });
      continue;
    }
    try {
      entries.push(await syncWorkflow(hosts, file, source, envName, set, env.uid));
    } catch (error) {
      entries.push({
        ...(before ?? environmentStatus({ name: envName, environmentSet: set, phase: 'Error' })),
        environmentSet: set,
        podUID: env.uid,
        phase: 'Error',
        message: errorMessage(error),
      });
    }
  }
  const removing: WorkflowEnvironmentStatus[] = [];
  for (const status of previous.values()) {
    if (chosen.includes(status.name)) continue;
    const left = await removeWorkflow(hosts, world, file, status);
    if (left) removing.push(left);
  }

  let phase: string;
  let message: string | null;
  if (chosen.length === 0) {
    phase = 'Waiting';
    message =
      candidates.length === 0
        ? 'no environment set matches environmentSetSelector'
        : projects.length > 0
          ? `waiting for a ready environment where ${projects.join(', ')} ${projects.length === 1 ? 'is' : 'are'} Ready`
          : 'waiting for a ready environment';
  } else {
    phase = aggregate(entries);
    const noted = [...entries, ...removing].find((e) => e.message !== null);
    message = noted ? `${noted.name}: ${noted.message}` : null;
  }
  await write(phase, message, [...entries, ...removing], hash(source));
  return [...entries, ...removing].map((e) => e.name);
}
