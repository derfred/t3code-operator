// Runs the end-to-end scenario: a fake Kubernetes API server (in this
// process), a t3 server, and the operator, as its production image.
//
//   node e2e/run.ts [--operator-image IMAGE] [--t3-image IMAGE]
//
// Without --operator-image, the image is built from this checkout's
// Dockerfile; without --t3-image, from e2e/t3.Dockerfile (t3 from npm). Both
// run in Docker. The operator container gets exactly what a cluster gives
// it: KUBERNETES_SERVICE_HOST/PORT, a service-account token and CA at
// /var/run/secrets/kubernetes.io/serviceaccount, and the t3 API token file.
//
// Without Docker (`--operator process`, with --t3-url and --t3-token for a
// t3 already running locally): the operator runs as `node src/main.ts`. It
// reads the service-account token from the same fixed path, so that only
// works where that path exists, such as inside a pod.
//
// The operator's exec into the pod (Session auth) runs the command in the t3
// container with `docker exec`; with --t3-url, here, as `t3` on the PATH
// (set T3CODE_HOME to the running t3's data directory).

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { FakeApiServer, type ExecHandler } from './fake-apiserver.ts';
import { NAMESPACE, STATEFUL_SET, run } from './scenario.ts';
import { makeT3 } from '../src/t3.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    'operator-image': { type: 'string' },
    't3-image': { type: 'string' },
    operator: { type: 'string', default: 'docker' },
    't3-url': { type: 'string' },
    't3-token': { type: 'string' },
    remote: { type: 'string' },
    workspace: { type: 'string' },
  },
});

const sh = (cmd: string, argv: string[], options: { cwd?: string; quiet?: boolean } = {}) =>
  execFileSync(cmd, argv, { cwd: options.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', options.quiet ? 'pipe' : 'inherit'] }).trim();
const docker = (...argv: string[]) => sh('docker', argv);
const log = (message: string) => console.log(`e2e: ${message}`);

const work = mkdtempSync(join(tmpdir(), 't3code-operator-e2e-'));
const cleanups: Array<() => void> = [];
// Run before the cleanups, on failure only: container logs.
const diagnostics: Array<() => void> = [];

// On GitHub Actions, also as an annotation: those can be read through the
// API, where the job log may not be reachable.
function report(title: string, text: string) {
  console.error(`--- ${title}\n${text}`);
  if (!process.env.GITHUB_ACTIONS) return;
  const escaped = text.slice(-12_000).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log(`::error title=e2e ${title}::${escaped}`);
}
const id = `${process.pid}`;

// Runs a command to its end: its output and exit code, never a throw.
const runCommand: (argv: string[]) => ReturnType<ExecHandler> = (argv) =>
  new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (error) => resolve({ stdout, stderr: String(error), exitCode: 127 }));
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
  });

// A CA, and a certificate for the fake API server signed by it, valid for
// the names the operator may use for it.
function certificates() {
  const ssl = (...argv: string[]) => sh('openssl', argv, { cwd: work, quiet: true });
  ssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-subj', '/CN=e2e-ca', '-keyout', 'ca.key', '-out', 'ca.crt');
  ssl('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-subj', '/CN=kubernetes',
    '-keyout', 'server.key', '-out', 'server.csr');
  writeFileSync(join(work, 'san.ext'), 'subjectAltName=DNS:kubernetes,IP:127.0.0.1\n');
  ssl('x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1',
    '-extfile', 'san.ext', '-out', 'server.crt');
  return { ca: join(work, 'ca.crt'), key: readFileSync(join(work, 'server.key'), 'utf8'), cert: readFileSync(join(work, 'server.crt'), 'utf8') };
}

async function waitForHttp(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${url} did not answer 200 within ${timeoutMs / 1000}s`);
}

// A t3 server in Docker, with a bare repository inside it to clone.
async function startT3() {
  const image = args['t3-image'] ?? 't3code-operator-e2e-t3';
  if (!args['t3-image']) {
    log('building the t3 image (e2e/t3.Dockerfile)');
    docker('build', '-q', '-t', image, '-f', join(root, 'e2e/t3.Dockerfile'), join(root, 'e2e'));
  }
  const name = `t3code-operator-e2e-t3-${id}`;
  docker('run', '-d', '--name', name, '-p', '127.0.0.1::3773', image, 't3', 'serve', '--host', '0.0.0.0', '--port', '3773');
  cleanups.push(() => sh('docker', ['rm', '-f', name], { quiet: true }));
  diagnostics.push(() => report('t3 logs', sh('docker', ['logs', '--tail', '50', name], { quiet: true })));
  const port = docker('port', name, '3773/tcp').split('\n')[0]!.split(':').pop()!;
  const url = `http://127.0.0.1:${port}`;
  log(`t3 (${image}) starting at ${url}`);
  await waitForHttp(`${url}/`, 180_000);
  docker('exec', name, 'sh', '-euc', [
    'git init -q /tmp/src && cd /tmp/src && echo e2e > README.md && git add README.md',
    'git -c user.name=e2e -c user.email=e2e@example.com commit -qm init',
    'git clone -q --bare /tmp/src /tmp/origin.git',
    'mkdir -p /tmp/workspace',
  ].join('\n'));
  // Every t3 has this; --auth-token-file only newer ones.
  const token = docker('exec', name, 't3', 'auth', 'session', 'issue', '--token-only', '--label', 'operator-e2e');
  const podIP = docker('inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', name);
  const exec: ExecHandler = (_pod, _container, command) => runCommand(['docker', 'exec', name, ...command]);
  return { url, token, podIP, t3Port: '3773', remote: '/tmp/origin.git', workspace: '/tmp/workspace', exec };
}

const tokenDir = join(work, 'api-token');

function startOperator(apiPort: number, ca: string, t3Token: string, t3Port: string): ChildProcess | undefined {
  mkdirSync(tokenDir);
  // One file per StatefulSet, as the projected volume in a cluster has it.
  writeFileSync(join(tokenDir, STATEFUL_SET), t3Token);
  const env = {
    NAMESPACE,
    T3CODE_API_TOKEN_DIR: '/etc/t3code/api',
    T3CODE_PORT: t3Port,
  };

  if (args.operator === 'process') {
    const child = spawn(process.execPath, [join(root, 'src/main.ts')], {
      env: {
        ...process.env,
        ...env,
        T3CODE_API_TOKEN_DIR: tokenDir,
        KUBERNETES_SERVICE_HOST: '127.0.0.1',
        KUBERNETES_SERVICE_PORT: String(apiPort),
        NODE_EXTRA_CA_CERTS: ca,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', (d) => process.stdout.write(`operator: ${d}`));
    child.stderr!.on('data', (d) => process.stderr.write(`operator: ${d}`));
    cleanups.push(() => child.kill());
    return child;
  }

  const image = args['operator-image'] ?? 't3code-operator:e2e';
  if (!args['operator-image']) {
    log('building the operator image (Dockerfile)');
    docker('build', '-q', '-t', image, root);
  }
  // Where a cluster mounts them; readable by the image's non-root user.
  const sa = join(work, 'serviceaccount');
  mkdirSync(sa);
  writeFileSync(join(sa, 'token'), 'e2e-service-account-token');
  writeFileSync(join(sa, 'ca.crt'), readFileSync(ca));
  writeFileSync(join(sa, 'namespace'), NAMESPACE);
  for (const dir of [work, sa, tokenDir]) chmodSync(dir, 0o755);
  for (const file of [join(sa, 'token'), join(sa, 'ca.crt'), join(sa, 'namespace'), join(tokenDir, STATEFUL_SET)]) chmodSync(file, 0o644);
  const name = `t3code-operator-e2e-operator-${id}`;
  docker('run', '-d', '--name', name,
    // The fake API server runs in this process, on the host.
    '--add-host', 'kubernetes:host-gateway',
    '-e', 'KUBERNETES_SERVICE_HOST=kubernetes', '-e', `KUBERNETES_SERVICE_PORT=${apiPort}`,
    ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    '-v', `${sa}:/var/run/secrets/kubernetes.io/serviceaccount:ro`,
    '-v', `${tokenDir}:/etc/t3code/api:ro`,
    image);
  cleanups.push(() => sh('docker', ['rm', '-f', name], { quiet: true }));
  diagnostics.push(() => report('operator logs', sh('docker', ['logs', '--tail', '100', name], { quiet: true })));
  log(`operator (${image}) started`);
  return undefined;
}

const api = new FakeApiServer();
let ok = false;
try {
  const { ca, key, cert } = certificates();
  const apiPort = await api.listen({ key, cert });
  log(`fake Kubernetes API server on port ${apiPort}`);

  const t3 =
    args['t3-url'] && args['t3-token']
      ? {
          url: args['t3-url'],
          token: args['t3-token'],
          podIP: new URL(args['t3-url']).hostname,
          t3Port: new URL(args['t3-url']).port || '80',
          remote: args.remote ?? '',
          workspace: args.workspace ?? '',
          exec: ((_pod, _container, command) => runCommand(command)) as ExecHandler,
        }
      : await startT3();
  api.exec = t3.exec;
  startOperator(apiPort, ca, t3.token, t3.t3Port);

  const client = makeT3(t3.url, t3.token);
  try {
    await run({
      api,
      t3: client,
      podIP: t3.podIP,
      remote: t3.remote,
      workspace: t3.workspace,
      // In the t3 container, as the operator's exec runs it.
      exec: async (command) => {
        const out = await t3.exec('t3-e2e-0', 't3', command);
        if (out.exitCode !== 0) throw new Error(`${command.join(' ')}: exit ${out.exitCode}: ${out.stderr}`);
        return out.stdout;
      },
      // A bind mount in Docker: the operator sees the change.
      replaceFileToken: (token) => writeFileSync(join(tokenDir, STATEFUL_SET), token),
    });
  } finally {
    client.close();
  }
  ok = true;
  log('passed');
} catch (error) {
  report('FAILED', error instanceof Error ? (error.stack ?? error.message) : String(error));
  report('T3Projects', JSON.stringify(api.list(`/apis/t3code.derfred.com/v1alpha1/namespaces/${NAMESPACE}/t3projects`).map((p) => ({ name: p.metadata.name, spec: p.spec, status: p.status })), null, 1));
} finally {
  for (const step of [...(ok ? [] : diagnostics), ...cleanups.reverse()]) {
    try {
      step();
    } catch {}
  }
  await api.close();
  rmSync(work, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
