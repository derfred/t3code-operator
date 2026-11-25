// The repository clones of multi-repository projects (spec.repositories),
// which outlive a reconcile pass.
//
// t3's sourceControl.cloneRepository clones into a folder without
// registering a project, but answers only once git is done, and has no
// progress feed. So each clone is a call on a connection of its own, kept
// here between passes, and a pass reads where it stands. Clones live in
// memory only: after an operator restart the closed connection ends t3's
// clone (git removes what it wrote when it is stopped), and the next pass
// starts it again.

import type { T3 } from './t3.ts';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

// How long one clone may take before the call gives up on it.
export const CLONE_TIMEOUT_MS = 60 * 60 * 1000;

export interface CloneJob {
  readonly remoteUrl: string;
  // The pod the clone runs in: a restarted pod ended it.
  readonly podUID: string;
  readonly phase: 'running' | 'done' | 'failed';
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly error: string | null;
  // Done without cloning: the folder already held files, which are kept.
  readonly existing: boolean;
}

export interface CloneRequest {
  readonly environment: string;
  readonly podUID: string;
  readonly destinationPath: string;
  readonly remoteUrl: string;
}

export class Clones {
  readonly #jobs = new Map<string, { job: CloneJob; settled: Promise<void> }>();
  readonly #now: () => Date;
  // How long `start` waits for a quick answer, such as a folder that already
  // has a checkout, so that it shows in the same pass.
  readonly #quickMs: number;
  // Called when a clone ends, to run a pass that records it.
  readonly #onEnd: () => void;

  constructor(options: { readonly now?: () => Date; readonly quickMs?: number; readonly onEnd?: () => void } = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#quickMs = options.quickMs ?? 2_000;
    this.#onEnd = options.onEnd ?? (() => undefined);
  }

  get(environment: string, destinationPath: string): CloneJob | undefined {
    return this.#jobs.get(key(environment, destinationPath))?.job;
  }

  forget(environment: string, destinationPath: string): void {
    this.#jobs.delete(key(environment, destinationPath));
  }

  // Starts a clone on `client`, which it owns and closes when the clone ends,
  // and waits briefly for it. Resolves to the job as it then stands.
  async start(request: CloneRequest, client: T3): Promise<CloneJob> {
    const id = key(request.environment, request.destinationPath);
    const running = this.#jobs.get(id);
    if (running?.job.phase === 'running' && running.job.podUID === request.podUID) {
      client.close();
      return running.job;
    }
    const startedAt = this.#now().toISOString();
    const entry = {
      job: {
        remoteUrl: request.remoteUrl,
        podUID: request.podUID,
        phase: 'running',
        startedAt,
        endedAt: null,
        error: null,
        existing: false,
      } as CloneJob,
      settled: Promise.resolve(),
    };
    const end = (fields: Partial<CloneJob>) => {
      // A later start (a forget, then a new clone) owns the entry now.
      if (this.#jobs.get(id) === entry) entry.job = { ...entry.job, endedAt: this.#now().toISOString(), ...fields };
    };
    entry.settled = client
      .call('sourceControl.cloneRepository', { remoteUrl: request.remoteUrl, destinationPath: request.destinationPath }, { timeoutMs: CLONE_TIMEOUT_MS })
      .then(
        () => end({ phase: 'done' }),
        (error) =>
          // Files there already: a checkout from before (an earlier clone,
          // a restarted pod) or put there by hand. Kept as it is.
          /not empty/i.test(errorMessage(error))
            ? end({ phase: 'done', existing: true })
            : end({ phase: 'failed', error: errorMessage(error) }),
      )
      .finally(() => {
        client.close();
        this.#onEnd();
      });
    this.#jobs.set(id, entry);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([entry.settled, new Promise<void>((resolve) => (timer = setTimeout(resolve, this.#quickMs)))]);
    clearTimeout(timer);
    return entry.job;
  }

  // Every clone still running, settled. For tests.
  async settled(): Promise<void> {
    await Promise.all([...this.#jobs.values()].map((e) => e.settled));
  }
}

const key = (environment: string, destinationPath: string) => `${environment}\u0000${destinationPath}`;
