// Client for one t3 server: plain HTTP for what it serves (project list and
// mutations, the WebSocket ticket) and its WebSocket RPC for the rest.
//
// The RPC is Effect RPC with JSON serialization: one JSON message per frame,
// a request is {_tag: 'Request', id, tag, payload, headers}, and the server
// answers with {_tag: 'Exit', requestId, exit}. Only unary methods are used
// here, so stream chunks, acks and interrupts never come up.

export interface T3Project {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly archivedAt?: string | null;
  readonly deletedAt: string | null;
}

export interface T3 {
  listProjects(): Promise<ReadonlyArray<T3Project>>;
  mutateProject(mutation: Record<string, unknown>): Promise<void>;
  call(method: string, payload: unknown): Promise<unknown>;
  close(): void;
}

export class T3Error extends Error {
  readonly tag: string | undefined;
  constructor(message: string, tag?: string) {
    super(message);
    this.name = 'T3Error';
    this.tag = tag;
  }
}

// t3 orchestration protocol the /ws endpoint insists on. Bump with t3 when a
// release changes it; the server answers 426 to anything else.
const ORCHESTRATION_PROTOCOL = '2';
const CALL_TIMEOUT_MS = 60_000;

type Pending = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

// A tagged error from the server reads best as its message, falling back to
// the fields that carry the detail (SourceControlRepositoryError has `detail`).
export function describeFailure(cause: unknown): T3Error {
  const entries = Array.isArray(cause) ? cause : [];
  for (const entry of entries) {
    if (entry?._tag === 'Fail') {
      const error = entry.error ?? {};
      const message = error.message ?? error.detail ?? JSON.stringify(error);
      return new T3Error(String(message), typeof error._tag === 'string' ? error._tag : undefined);
    }
    if (entry?._tag === 'Die') {
      return new T3Error(`server defect: ${JSON.stringify(entry.defect)}`);
    }
  }
  return new T3Error(`request failed: ${JSON.stringify(cause)}`);
}

// Settles the pending call a frame answers. Returns false for frames that
// answer nothing (Pong, or a response to a call that already timed out).
export function settleFrame(frame: any, pending: Map<string, Pending>): boolean {
  if (frame?._tag === 'Defect') {
    for (const [id, call] of pending) {
      clearTimeout(call.timer);
      call.reject(new T3Error(`protocol defect: ${JSON.stringify(frame.defect)}`));
      pending.delete(id);
    }
    return true;
  }
  if (frame?._tag !== 'Exit') return false;
  const id = String(frame.requestId);
  const call = pending.get(id);
  if (!call) return false;
  pending.delete(id);
  clearTimeout(call.timer);
  if (frame.exit?._tag === 'Success') call.resolve(frame.exit.value);
  else call.reject(describeFailure(frame.exit?.cause));
  return true;
}

export function makeT3(origin: string, token: string): T3 {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  let socket: Promise<WebSocket> | undefined;
  const pending = new Map<string, Pending>();
  let nextId = 0;

  const http = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(origin + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) throw new T3Error(`${method} ${path}: HTTP ${response.status} ${text.slice(0, 500)}`);
    return text.length === 0 ? undefined : JSON.parse(text);
  };

  const failAll = (error: Error) => {
    for (const [id, call] of pending) {
      clearTimeout(call.timer);
      call.reject(error);
      pending.delete(id);
    }
  };

  const connect = async (): Promise<WebSocket> => {
    const { ticket } = await http('POST', '/api/auth/websocket-ticket/rpc');
    const url = new URL('/ws', origin.replace(/^http/, 'ws'));
    url.searchParams.set('orchestrationProtocol', ORCHESTRATION_PROTOCOL);
    url.searchParams.set('wsTicket', ticket);
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new T3Error(`WebSocket to ${origin} failed`)), { once: true });
    });
    ws.addEventListener('message', (event) => {
      const decoded = JSON.parse(String(event.data));
      for (const frame of Array.isArray(decoded) ? decoded : [decoded]) settleFrame(frame, pending);
    });
    ws.addEventListener('close', () => {
      socket = undefined;
      failAll(new T3Error(`WebSocket to ${origin} closed`));
    });
    return ws;
  };

  return {
    listProjects: async () => (await http('GET', '/api/projects')).projects,
    mutateProject: async (mutation) => {
      await http('POST', '/api/projects/mutate', mutation);
    },
    call: async (method, payload) => {
      socket ??= connect();
      let ws: WebSocket;
      try {
        ws = await socket;
      } catch (error) {
        socket = undefined;
        throw error;
      }
      const id = String(++nextId);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new T3Error(`${method} timed out`));
        }, CALL_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ _tag: 'Request', id, tag: method, payload, headers: [] }));
      });
    },
    close: () => {
      const current = socket;
      socket = undefined;
      current?.then((ws) => ws.close(), () => undefined);
    },
  };
}
