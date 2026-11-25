// How the operator authenticates to the t3 of each environment, chosen per
// T3EnvironmentSet by spec.auth.mode:
//
// - File: a token the operator reads from <tokenDir>/<statefulSet>, which
//   the pods accept because they read the same token (`t3 serve
//   --auth-token-file`, in the derfred/t3code fork).
// - Session: a token each pod issues itself, through `t3 auth session issue`
//   run in its t3 container (pods/exec). Upstream t3 signs it with a key in
//   the pod's own data directory, so it is a token per pod, held in memory.
//   One per pod at a time: issuing a new one revokes the ones before it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type AuthMode = 'File' | 'Session';

// T3EnvironmentSet spec.auth, as the CRD has it.
export interface AuthSpec {
  readonly mode?: AuthMode;
  // Session only: the pod's t3 container, and how long a token lives.
  readonly container?: string;
  readonly ttl?: string;
}

export const DEFAULT_CONTAINER = 't3';
export const DEFAULT_TTL = '7d';

// The bearer token for one t3. refresh() is for after a 401: it gets a token
// again rather than serving the one t3 just refused.
export interface Credentials {
  token(): Promise<string>;
  refresh(): Promise<string>;
}

// The sessions the operator issues carry this subject; it revokes only those.
export const SESSION_SUBJECT = 't3code-operator';
// What the operator calls (docs/design.md, What t3 exposes), and no more.
export const SESSION_SCOPES = [
  'orchestration:read',
  'orchestration:operate',
  'settings:write',
  'source-control:write',
  'filesystem:read',
  // Saving and deleting workflow files: code the host runs (T3Workflow).
  'terminal:operate',
] as const;

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

// A ttl as the CRD allows it: a whole number and one of s, m, h, d. t3
// takes the same string.
export function parseTtl(ttl: string): number {
  const m = /^([1-9][0-9]*)([smhd])$/.exec(ttl);
  if (!m) throw new Error(`auth.ttl ${JSON.stringify(ttl)}: expected a number and s, m, h or d, such as 7d`);
  return Number(m[1]) * UNITS[m[2]!]!;
}

// File mode: read when first asked for in a pass, and again on refresh, so
// a rotated Secret is picked up mid-pass too.
export function fileCredentials(tokenDir: string, statefulSet: string): Credentials {
  let cached: string | undefined;
  const read = async () => {
    try {
      cached = readFileSync(join(tokenDir, statefulSet), 'utf8').trim();
    } catch (error) {
      throw new Error(`no API token for StatefulSet ${statefulSet} in ${tokenDir}: ${String(error)}`);
    }
    return cached;
  };
  return { token: async () => cached ?? read(), refresh: read };
}

// Runs a command in a pod's container; resolves with its stdout, rejects
// when it can't run or exits non-zero.
export type Exec = (pod: string, container: string, command: ReadonlyArray<string>) => Promise<string>;

interface Session {
  readonly podUID: string;
  readonly ttl: string;
  readonly token: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

// A refused token this young is not issued again: t3 refusing a token it has
// just issued won't change by issuing another, and every call would exec.
const REISSUE_AFTER_401_MS = 60_000;

export class Sessions {
  readonly #exec: Exec;
  readonly #now: () => Date;
  readonly #log: (message: string, fields: Record<string, unknown>) => void;
  // By pod name. A new pod UID (a pod recreated, maybe on a fresh volume)
  // starts over.
  readonly #sessions = new Map<string, Session>();
  readonly #issuing = new Map<string, Promise<Session>>();

  constructor(exec: Exec, now: () => Date, log: (message: string, fields: Record<string, unknown>) => void = () => {}) {
    this.#exec = exec;
    this.#now = now;
    this.#log = log;
  }

  credentials(pod: { readonly name: string; readonly uid: string }, spec: AuthSpec): Credentials {
    const container = spec.container ?? DEFAULT_CONTAINER;
    const ttl = spec.ttl ?? DEFAULT_TTL;
    const get = async (afterRefusal: boolean) => {
      const ttlMs = parseTtl(ttl);
      const now = this.#now().getTime();
      const current = this.#sessions.get(pod.name);
      const usable =
        current !== undefined &&
        current.podUID === pod.uid &&
        current.ttl === ttl &&
        // Renewed halfway through its life, so it never runs out between passes.
        current.expiresAt - now > ttlMs / 2 &&
        !(afterRefusal && now - current.issuedAt >= REISSUE_AFTER_401_MS);
      return usable ? current.token : (await this.#issue(pod, container, ttl)).token;
    };
    return { token: () => get(false), refresh: () => get(true) };
  }

  // Forgets the pods not in `pods` (by name): gone, so their tokens are too.
  retain(pods: ReadonlySet<string>): void {
    for (const name of this.#sessions.keys()) if (!pods.has(name)) this.#sessions.delete(name);
  }

  #issue(pod: { readonly name: string; readonly uid: string }, container: string, ttl: string): Promise<Session> {
    let issuing = this.#issuing.get(pod.name);
    if (!issuing) {
      issuing = this.#issueNow(pod, container, ttl).finally(() => this.#issuing.delete(pod.name));
      this.#issuing.set(pod.name, issuing);
    }
    return issuing;
  }

  async #issueNow(pod: { readonly name: string; readonly uid: string }, container: string, ttl: string): Promise<Session> {
    const t3 = (...args: string[]) => this.#exec(pod.name, container, ['t3', 'auth', 'session', ...args]);
    let issued: { sessionId?: unknown; token?: unknown; expiresAt?: unknown };
    try {
      issued = JSON.parse(
        await t3('issue', '--json', '--subject', SESSION_SUBJECT, '--label', SESSION_SUBJECT, '--ttl', ttl, ...SESSION_SCOPES.flatMap((s) => ['--scope', s])),
      );
    } catch (error) {
      throw new Error(`issuing a session token in ${pod.name}/${container}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const expiresAt = Date.parse(String(issued.expiresAt));
    if (typeof issued.token !== 'string' || typeof issued.sessionId !== 'string' || Number.isNaN(expiresAt)) {
      throw new Error(`issuing a session token in ${pod.name}/${container}: unexpected answer from t3 auth session issue`);
    }
    const session = { podUID: pod.uid, ttl, token: issued.token, issuedAt: this.#now().getTime(), expiresAt };
    this.#sessions.set(pod.name, session);
    this.#log('issued a session token', { pod: pod.name, sessionId: issued.sessionId, expiresAt: issued.expiresAt });

    // The ones before it, from earlier passes or an operator that restarted.
    // Best effort: the new token works either way, and a leftover expires.
    try {
      const sessions = JSON.parse(await t3('list', '--json'));
      for (const s of Array.isArray(sessions) ? sessions : []) {
        if (s?.subject !== SESSION_SUBJECT || s.sessionId === issued.sessionId || typeof s.sessionId !== 'string') continue;
        await t3('revoke', s.sessionId);
        this.#log('revoked an earlier session token', { pod: pod.name, sessionId: s.sessionId });
      }
    } catch (error) {
      this.#log('revoking earlier session tokens failed', { pod: pod.name, error: String(error) });
    }
    return session;
  }
}
