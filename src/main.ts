// t3code operator: places T3Project resources (and their scheduled tasks) on
// the environments of the T3EnvironmentSets they select, and gates each
// environment's readiness on its contents.
//
// A pass reads everything and reconciles everything. Passes run when a watch
// sees a T3Project, T3EnvironmentSet or t3 pod change (watch.ts), and on a
// timer for what no watch can see, inside t3: every CLONING_POLL_SECONDS
// while a clone is under way, else every RESYNC_INTERVAL_SECONDS.
// Run with Node's built-in type stripping: `node main.ts`.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GROUP, VERSION, makeKube } from './kube.ts';
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

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
};

const namespace = required('NAMESPACE');
// One token per StatefulSet: t3 pods of different sets accept different
// tokens, each in a file named after its StatefulSet.
const tokenDir = required('T3CODE_API_TOKEN_DIR');
const port = process.env.T3CODE_PORT ?? '3773';
const resyncMs = Number(process.env.RESYNC_INTERVAL_SECONDS ?? '300') * 1000;
const cloningPollMs = Number(process.env.CLONING_POLL_SECONDS ?? '5') * 1000;

const log = (level: string, message: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), level, message, ...fields }));

const kube = makeKube(namespace);

// Returns whether a clone is under way somewhere, which shortens the next wait.
async function pass(): Promise<boolean> {
  // Read per pass: the Secrets are mounted without subPath, so a rotated
  // token lands here without a restart. A t3 with --auth-token-file watches
  // its own copy and switches over the same way.
  const tokens = new Map<string, string>();
  const tokenFor = (statefulSet: string) => {
    let token = tokens.get(statefulSet);
    if (token === undefined) {
      try {
        token = readFileSync(join(tokenDir, statefulSet), 'utf8').trim();
      } catch (error) {
        throw new Error(`no API token for StatefulSet ${statefulSet} in ${tokenDir}: ${String(error)}`);
      }
      tokens.set(statefulSet, token);
    }
    return token;
  };
  // environment (pod) -> the StatefulSet it belongs to, for its token.
  const statefulSetOf = new Map<string, string>();
  const clients = new Map<string, T3>();
  try {
    const setResources = await kube.list<EnvironmentSetResource>('t3environmentsets');
    const sets: PlacedSet[] = [];
    for (const set of setResources) {
      const environments = await kube.statefulSetEnvironments(set.spec.statefulSet);
      for (const env of environments ?? []) statefulSetOf.set(env.name, set.spec.statefulSet);
      sets.push({
        name: set.metadata.name,
        labels: set.metadata.labels ?? {},
        environments,
      });
    }
    const world = new World(sets);
    const deps = {
      kube,
      // On the pod's IP, as of this pass: reconcile only calls ready
      // environments, and a ready pod has an IP.
      t3: (environment: string) => {
        let client = clients.get(environment);
        if (!client) {
          const ip = world.environment(environment)?.ip;
          if (!ip) throw new Error(`environment ${environment} has no pod IP`);
          const statefulSet = statefulSetOf.get(environment);
          if (!statefulSet) throw new Error(`environment ${environment} belongs to no StatefulSet`);
          client = makeT3(`http://${ip.includes(':') ? `[${ip}]` : ip}:${port}`, tokenFor(statefulSet));
          clients.set(environment, client);
        }
        return client;
      },
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

    for (const [i, set] of setResources.entries()) {
      try {
        await reconcileEnvironmentSet(deps, set, sets[i]!, placed);
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

const trigger = new Trigger();
const custom = `/apis/${GROUP}/${VERSION}/namespaces/${namespace}`;
const watched = [
  `${custom}/t3projects`,
  `${custom}/t3environmentsets`,
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
