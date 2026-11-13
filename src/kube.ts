// The few Kubernetes API calls the operator makes, over fetch with the pod's
// ServiceAccount. The API server's CA reaches fetch through
// NODE_EXTRA_CA_CERTS (set in the Deployment), so no client library is needed.

import { readFileSync } from 'node:fs';

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
export const GROUP = 't3code.derfred.com';
export const VERSION = 'v1alpha1';
// The pod readiness gate the t3 pods declare (see README.md).
export const CONTENT_READY = `${GROUP}/content-ready`;

export interface Metadata {
  readonly name: string;
  readonly uid?: string;
  readonly generation?: number;
  readonly resourceVersion?: string;
  readonly deletionTimestamp?: string;
  readonly finalizers?: ReadonlyArray<string>;
  readonly labels?: Readonly<Record<string, string>>;
}

export interface Resource<Spec, Status> {
  readonly metadata: Metadata;
  readonly spec: Spec;
  readonly status?: Status;
}

// One t3 environment: a pod of an environment set's StatefulSet.
export interface Environment {
  readonly name: string;
  readonly uid: string;
  // The operator talks to t3 on the pod's IP: no Service per pod needed.
  readonly ip: string | null;
  // ContainersReady, not Ready: Ready also waits on the content gate, which
  // the operator itself sets, after it has talked to t3.
  readonly ready: boolean;
  readonly contentReady: boolean | undefined;
}

export interface Kube {
  list<R>(plural: string): Promise<ReadonlyArray<R>>;
  // A raw authenticated GET, for watches (watch.ts).
  get(path: string, signal: AbortSignal): Promise<Response>;
  // Merge patch. Include metadata.resourceVersion to make it conditional.
  patch(plural: string, name: string, body: unknown): Promise<void>;
  patchStatus(plural: string, name: string, status: unknown): Promise<void>;
  // null when the StatefulSet does not exist.
  statefulSetEnvironments(name: string): Promise<ReadonlyArray<Environment> | null>;
  setContentReady(pod: string, ready: boolean, message: string): Promise<void>;
}

export class KubeError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'KubeError';
    this.status = status;
  }
}

const condition = (pod: any, type: string) =>
  (pod.status?.conditions ?? []).find((c: any) => c.type === type)?.status;

export function toEnvironment(pod: any): Environment {
  const gate = condition(pod, CONTENT_READY);
  const ip = pod.status?.podIP ?? null;
  return {
    name: pod.metadata.name,
    uid: pod.metadata.uid,
    ip,
    ready: !pod.metadata.deletionTimestamp && ip !== null && condition(pod, 'ContainersReady') === 'True',
    contentReady: gate === undefined ? undefined : gate === 'True',
  };
}

export function makeKube(namespace: string): Kube {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT ?? '443';
  if (!host) throw new Error('KUBERNETES_SERVICE_HOST is not set; the operator runs in-cluster only');
  const base = `https://${host.includes(':') ? `[${host}]` : host}:${port}`;
  const custom = `/apis/${GROUP}/${VERSION}/namespaces/${namespace}`;

  // Re-read on every call: the projected token rotates.
  const authorization = () => `Bearer ${readFileSync(`${SA_DIR}/token`, 'utf8').trim()}`;

  const request = async (method: string, path: string, body?: unknown, contentType = 'application/merge-patch+json') => {
    const response = await fetch(base + path, {
      method,
      headers: {
        authorization: authorization(),
        ...(body === undefined ? {} : { 'content-type': contentType }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new KubeError(`${method} ${path}: HTTP ${response.status} ${text.slice(0, 300)}`, response.status);
    }
    return text.length === 0 ? undefined : JSON.parse(text);
  };

  return {
    list: async (plural) => (await request('GET', `${custom}/${plural}`)).items,
    get: (path, signal) => fetch(base + path, { headers: { authorization: authorization() }, signal }),
    patch: async (plural, name, body) => {
      await request('PATCH', `${custom}/${plural}/${name}`, body);
    },
    patchStatus: async (plural, name, status) => {
      await request('PATCH', `${custom}/${plural}/${name}/status`, { status });
    },
    statefulSetEnvironments: async (name) => {
      let sts;
      try {
        sts = await request('GET', `/apis/apps/v1/namespaces/${namespace}/statefulsets/${name}`);
      } catch (error) {
        if (error instanceof KubeError && error.status === 404) return null;
        throw error;
      }
      // The StatefulSet's own selector, so pods are found the way it finds them.
      const selector = Object.entries(sts.spec.selector.matchLabels ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join(',');
      const pods = await request('GET', `/api/v1/namespaces/${namespace}/pods?labelSelector=${encodeURIComponent(selector)}`);
      return pods.items
        .map(toEnvironment)
        .sort((a: Environment, b: Environment) => a.name.localeCompare(b.name, 'en', { numeric: true }));
    },
    setContentReady: async (pod, ready, message) => {
      // Strategic merge: conditions merge by type. A JSON merge patch would
      // replace the whole list, kubelet's conditions included.
      await request(
        'PATCH',
        `/api/v1/namespaces/${namespace}/pods/${pod}/status`,
        {
          status: {
            conditions: [
              {
                type: CONTENT_READY,
                status: ready ? 'True' : 'False',
                reason: ready ? 'ContentReady' : 'ContentPending',
                message,
                lastTransitionTime: new Date().toISOString(),
              },
            ],
          },
        },
        'application/strategic-merge-patch+json',
      );
    },
  };
}
