// t3code operator: places T3Project resources (and their scheduled tasks) and
// T3Workflow resources on the environments of the T3EnvironmentSets they
// select, and gates each environment's readiness on its projects.
//
// A pass reads everything and reconciles everything. Passes run when a watch
// sees a T3Project, T3Workflow, T3EnvironmentSet, ConfigMap or t3 pod change
// (watch.ts), and on a timer for what no watch can see, inside t3: every
// CLONING_POLL_SECONDS while a clone is under way, else every
// RESYNC_INTERVAL_SECONDS.
// Run with Node's built-in type stripping: `node main.ts`.

import { fileCredentials, Sessions, type AuthSpec, type Credentials } from './auth.ts';
import { Clones } from './clones.ts';
import { GROUP, KubeError, VERSION, makeKube } from './kube.ts';
import {
  reconcileEnvironmentSet,
  reconcileProject,
  World,
  type EnvironmentSetResource,
  type Placed,
  type PlacedSet,
  type ProjectResource,
} from './reconcile.ts';
import { makeT3, type T3 } from './t3.ts';
import { Trigger, watch } from './watch.ts';
import { PLURAL as WORKFLOWS, reconcileWorkflow, WorkflowHosts, type WorkflowResource } from './workflows.ts';

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
};

const namespace = required('NAMESPACE');
// File auth: one token per StatefulSet: t3 pods of different sets accept
// different tokens, each in a file named after its StatefulSet.
const tokenDir = required('T3CODE_API_TOKEN_DIR');
const port = process.env.T3CODE_PORT ?? '3773';
const resyncMs = Number(process.env.RESYNC_INTERVAL_SECONDS ?? '300') * 1000;
const cloningPollMs = Number(process.env.CLONING_POLL_SECONDS ?? '5') * 1000;

const log = (level: string, message: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), level, message, ...fields }));

const kube = makeKube(namespace);
// Session auth: the tokens the pods issued, kept from pass to pass.
const sessions = new Sessions(kube.exec, () => new Date(), (message, fields) => log('info', message, fields));
// The clones of multi-repository projects, which outlive a pass. One that
// ends runs a pass, which records it.
const trigger = new Trigger();
const clones = new Clones({ onEnd: () => trigger.notify() });

// The T3Workflows; none while their CustomResourceDefinition isn't installed
// yet (an operator upgraded before its CRDs), which mustn't stop the rest.
async function listWorkflows(): Promise<ReadonlyArray<WorkflowResource>> {
  try {
    return await kube.list<WorkflowResource>(WORKFLOWS);
  } catch (error) {
    if (!(error instanceof KubeError && error.status === 404)) throw error;
    log('warn', 'T3Workflow CustomResourceDefinition not found; apply the release’s install.yaml');
    return [];
  }
}

// Returns whether a clone is under way somewhere, which shortens the next wait.
async function pass(): Promise<boolean> {
  // File auth reads per pass: the Secrets are mounted without subPath, so a
  // rotated token lands here without a restart. A t3 with --auth-token-file
  // watches its own copy and switches over the same way.
  const files = new Map<string, Credentials>();
  // environment (pod) -> the set it belongs to, for its credentials.
  const setOf = new Map<string, { readonly statefulSet: string; readonly auth: AuthSpec }>();
  const credentialsFor = (environment: string, uid: string): Credentials => {
    const set = setOf.get(environment);
    if (!set) throw new Error(`environment ${environment} belongs to no StatefulSet`);
    if (set.auth.mode === 'Session') return sessions.credentials({ name: environment, uid }, set.auth);
    let file = files.get(set.statefulSet);
    if (!file) files.set(set.statefulSet, (file = fileCredentials(tokenDir, set.statefulSet)));
    return file;
  };
  const clients = new Map<string, T3>();
  try {
    const setResources = await kube.list<EnvironmentSetResource>('t3environmentsets');
    const sets: PlacedSet[] = [];
    for (const set of setResources) {
      const environments = await kube.statefulSetEnvironments(set.spec.statefulSet);
      for (const env of environments ?? []) setOf.set(env.name, { statefulSet: set.spec.statefulSet, auth: set.spec.auth ?? {} });
      sets.push({
        name: set.metadata.name,
        labels: set.metadata.labels ?? {},
        environments,
      });
    }
    const world = new World(sets);
    sessions.retain(new Set(setOf.keys()));
    // On the pod's IP, as of this pass: reconcile only calls ready
    // environments, and a ready pod has an IP.
    const connect = (environment: string) => {
      const env = world.environment(environment);
      if (!env?.ip) throw new Error(`environment ${environment} has no pod IP`);
      return makeT3(`http://${env.ip.includes(':') ? `[${env.ip}]` : env.ip}:${port}`, credentialsFor(environment, env.uid));
    };
    const deps = {
      kube,
      t3: (environment: string) => {
        let client = clients.get(environment);
        if (!client) {
          client = connect(environment);
          clients.set(environment, client);
        }
        return client;
      },
      // Not closed with the pass: Clones closes it when its clone ends.
      connect,
      clones,
      now: () => new Date(),
    };

    // environment -> the projects placed there, for the readiness gates.
    const placed = new Map<string, Placed[]>();
    for (const project of await kube.list<ProjectResource>('t3projects')) {
      let statuses;
      try {
        statuses = await reconcileProject(deps, project, world);
      } catch (error) {
        log('error', 'T3Project reconcile failed', { name: project.metadata.name, error: String(error) });
        statuses = project.status?.environments ?? [];
      }
      for (const status of statuses) {
        const entry = { project: project.metadata.name, phase: status.phase, cloningSince: status.cloningSince ?? null };
        placed.set(status.name, [...(placed.get(status.name) ?? []), entry]);
      }
    }

    // Workflows after projects: one waits for its projects to be Ready.
    const managed = new Map(
      setResources.flatMap((set) => (set.status?.environments ?? []).filter((e) => e.managesWorkflows === true).map((e) => [e.name, true] as const)),
    );
    const hosts = new WorkflowHosts(deps, managed);
    const projectReady = (env: string, project: string) => (placed.get(env) ?? []).some((p) => p.project === project && p.phase === 'Ready');
    const holders = new Set<string>();
    for (const workflow of await listWorkflows()) {
      let held: ReadonlyArray<string>;
      try {
        held = await reconcileWorkflow(deps, workflow, world, hosts, projectReady);
      } catch (error) {
        log('error', 'T3Workflow reconcile failed', { name: workflow.metadata.name, error: String(error) });
        held = (workflow.status?.environments ?? []).map((e) => e.name);
      }
      for (const env of held) holders.add(env);
    }
    await hosts.release(world, holders);

    for (const [i, set] of setResources.entries()) {
      try {
        await reconcileEnvironmentSet(deps, set, sets[i]!, placed, (env) => hosts.manages(env));
      } catch (error) {
        log('error', 'T3EnvironmentSet reconcile failed', { name: set.metadata.name, error: String(error) });
      }
    }
    return [...placed.values()].some((list) => list.some((p) => p.phase === 'Cloning'));
  } finally {
    for (const client of clients.values()) client.close();
  }
}

const stop = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => stop.abort());

const custom = `/apis/${GROUP}/${VERSION}/namespaces/${namespace}`;
const watched = [
  `${custom}/t3projects`,
  `${custom}/t3environmentsets`,
  `${custom}/t3workflows`,
  // A T3Workflow's sourceFrom: a changed ConfigMap reaches the pods without
  // the T3Workflow changing. Other ConfigMaps only cost a pass.
  `/api/v1/namespaces/${namespace}/configmaps`,
  // Every pod in the namespace: new t3 pods, readiness, scaling. StatefulSet
  // changes all show up here, so they need no watch of their own. Pods of
  // no set only cost a pass that changes nothing.
  `/api/v1/namespaces/${namespace}/pods`,
];
const watches = watched.map((path) =>
  watch({
    get: kube.get,
    path,
    onChange: () => trigger.notify(),
    signal: stop.signal,
    log: (message, fields) => log('warn', message, fields),
  }),
);

log('info', 'started', { namespace, resyncSeconds: resyncMs / 1000, cloningPollSeconds: cloningPollMs / 1000 });
let cloning = false;
while (!stop.signal.aborted) {
  try {
    cloning = await pass();
  } catch (error) {
    log('error', 'reconcile pass failed', { error: String(error) });
  }
  await trigger.wait(cloning ? cloningPollMs : resyncMs, stop.signal);
}
await Promise.allSettled(watches);
log('info', 'stopped');
