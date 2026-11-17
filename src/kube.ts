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
  // Runs a command in a pod's container (pods/exec); its stdout, or an error
  // when it can't run or exits non-zero. For Session auth (auth.ts).
  exec(pod: string, container: string, command: ReadonlyArray<string>): Promise<string>;
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

// The exec WebSocket's channels: the first byte of each binary message.
const STDOUT = 1;
const STDERR = 2;
// A metav1.Status as the last message: Success, or why not.
const STATUS = 3;
const EXEC_TIMEOUT_MS = 60_000;

// What an exec came to, from the bytes of each channel.
export function execOutcome(channels: ReadonlyMap<number, ReadonlyArray<Uint8Array>>): { ok: true; stdout: string } | { ok: false; error: string } {
  const text = (channel: number) => Buffer.concat(channels.get(channel) ?? []).toString('utf8');
  const statusText = text(STATUS);
  if (!statusText) return { ok: false, error: 'the connection closed without an exit status' };
  let status;
  try {
    status = JSON.parse(statusText);
  } catch {
    return { ok: false, error: `unreadable exit status: ${statusText.slice(0, 200)}` };
  }
  if (status.status === 'Success') return { ok: true, stdout: text(STDOUT) };
  const stderr = text(STDERR).trim();
  return { ok: false, error: [status.message ?? status.reason ?? 'failed', stderr.slice(-500)].filter(Boolean).join(': ') };
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
    exec: async (pod, container, command) => {
      const query = new URLSearchParams({ container, stdout: 'true', stderr: 'true' });
      for (const arg of command) query.append('command', arg);
      const path = `/api/v1/namespaces/${namespace}/pods/${encodeURIComponent(pod)}/exec?${query}`;
      const failed = (detail: string) => new KubeError(`exec in ${pod}/${container} (${command.slice(0, 4).join(' ')}): ${detail}`, 0);
      // v5 and v4 both end with a Status on channel 3; v5 only adds a way to
      // close stdin, which this never opens. Node's WebSocket (undici) takes
      // headers, and the API server's CA from NODE_EXTRA_CA_CERTS, as fetch does.
      const ws = new WebSocket(base.replace(/^http/, 'ws') + path, {
        protocols: ['v5.channel.k8s.io', 'v4.channel.k8s.io'],
        headers: { authorization: authorization() },
      } as any);
      ws.binaryType = 'arraybuffer';
      const channels = new Map<number, Uint8Array[]>();
      let errored = false;
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          ws.close();
          reject(failed(`no exit within ${EXEC_TIMEOUT_MS / 1000}s`));
        }, EXEC_TIMEOUT_MS);
        ws.addEventListener('message', (event) => {
          const bytes = new Uint8Array(event.data as ArrayBuffer);
          if (bytes.length === 0) return;
          channels.set(bytes[0]!, [...(channels.get(bytes[0]!) ?? []), bytes.subarray(1)]);
        });
        ws.addEventListener('close', () => {
          // After an error, which reports it.
          if (errored) return;
          clearTimeout(timer);
          const outcome = execOutcome(channels);
          if (outcome.ok) resolve(outcome.stdout);
          else reject(failed(outcome.error));
        });
        ws.addEventListener('error', () => {
          // A refused upgrade (no RBAC, no such pod) reaches the WebSocket
          // with no reason. The same request as a POST gets it in words.
          errored = true;
          clearTimeout(timer);
          request('POST', path).then(
            () => reject(failed('the WebSocket failed')),
            (error) => reject(failed(error instanceof KubeError && error.status === 400 ? 'the WebSocket failed' : String(error.message ?? error))),
          );
        });
      });
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
