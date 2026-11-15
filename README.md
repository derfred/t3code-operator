# t3code-operator

A Kubernetes operator for [T3 Code](https://github.com/pingdotgg/t3code)
environments. You declare projects (repositories, their t3 settings, their
scheduled tasks); it puts them on the t3 servers you run as StatefulSet pods,
keeps them in line with the declaration, and holds each pod's readiness until
its projects are in place.

- **Environment**: one t3 server, as t3 uses the word. Here, one pod.
- **Environment set** (`T3EnvironmentSet`): a StatefulSet and the
  environments it makes.
- **Project** (`T3Project`): a repository, its t3 settings, and its scheduled
  tasks, placed on the sets a label selector matches.

The operator never creates or changes the StatefulSets: they stay yours. It
reads them, talks to t3 on each pod, and sets one pod condition. Design and
trade-offs: [docs/design.md](docs/design.md).

## Install

```sh
kubectl apply -f https://raw.githubusercontent.com/derfred/t3code-operator/v0.1.0/deploy/install.yaml
```

That is [`deploy/install.yaml`](deploy/install.yaml) at a release: the
namespace `t3code`, the two CustomResourceDefinitions, and the operator
(ServiceAccount, Role, RoleBinding, Deployment). It runs as is; the operator
then needs a token for each StatefulSet of t3 pods it manages, in Secret
`t3code-operator-tokens` (see [Tokens](#tokens)).

For another namespace, or one Secret per StatefulSet, use the jsonnet library
it is rendered from, `deploy/jsonnet` (Tanka, for one). Vendor it at a release
tag with jsonnet-bundler (`jb install
github.com/derfred/t3code-operator/deploy/jsonnet@v0.1.0`), then:

```jsonnet
local operator = import 't3code-operator/main.libsonnet';
local cfg = operator.config {
  namespace: 'agents',
  // Optional: a Secret per StatefulSet instead of t3code-operator-tokens.
  // tokens: [{ statefulSet: 't3code-team', secret: 't3code-api-token-team' }],
};
operator.crds + operator.objects(cfg)
```

`crds` are cluster-scoped and must exist before anything using their kinds is
applied. `objects(cfg)` is the ServiceAccount, Role, RoleBinding and
Deployment in `cfg.namespace`; `rules` is the Role's rules on their own.
`config` documents every field; the default image is the release's own.

## Example

The t3 servers: a StatefulSet of two pods, each with its own home and
workspace volumes. The operator never creates these; they are yours to shape.
This one runs an image whose t3 reads its API token from a file (the first
way under [Tokens](#tokens)):

```yaml
apiVersion: v1
kind: Service
metadata:
  name: t3code-team
  namespace: t3code
spec:
  clusterIP: None                   # the StatefulSet's headless Service
  publishNotReadyAddresses: true    # reach pods while the operator holds their readiness
  selector: { app: t3code-team }
  ports: [{ name: http, port: 3773 }]
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: t3code-team
  namespace: t3code
spec:
  serviceName: t3code-team
  replicas: 2
  podManagementPolicy: Parallel
  selector:
    matchLabels: { app: t3code-team }
  template:
    metadata:
      labels: { app: t3code-team }
    spec:
      readinessGates:               # Ready once the operator has put the projects in place
        - conditionType: t3code.derfred.com/content-ready
      securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, runAsNonRoot: true }
      containers:
        - name: t3
          image: ghcr.io/derfred/t3code:2026.11.13-2
          # On all addresses, so the operator reaches it on the pod's IP.
          command: [t3, serve, --host, 0.0.0.0, --port, "3773"]
          env:
            - name: T3CODE_AUTH_TOKEN_FILE
              value: /etc/t3code/api/token
          ports: [{ name: http, containerPort: 3773 }]
          readinessProbe: { tcpSocket: { port: 3773 } }   # / needs auth: probe the port
          volumeMounts:
            - { name: api-token, mountPath: /etc/t3code/api, readOnly: true }
            - { name: home, mountPath: /home/node }      # t3's data: threads, settings
            - { name: workspace, mountPath: /workspace }  # the checkouts
      volumes:
        - name: api-token
          secret: { secretName: t3code-team-api-token }
  volumeClaimTemplates:
    - metadata: { name: home }
      spec: { accessModes: [ReadWriteOnce], resources: { requests: { storage: 5Gi } } }
    - metadata: { name: workspace }
      spec: { accessModes: [ReadWriteOnce], resources: { requests: { storage: 20Gi } } }
```

What the operator puts on them:

```yaml
apiVersion: t3code.derfred.com/v1alpha1
kind: T3EnvironmentSet
metadata:
  name: team
  namespace: t3code
  labels: { tier: team }
spec:
  statefulSet: t3code-team          # its pods are this set's environments
---
apiVersion: t3code.derfred.com/v1alpha1
kind: T3Project
metadata:
  name: my-app
  namespace: t3code
spec:
  repository: https://github.com/example/my-app.git
  environmentSetSelector:           # a LabelSelector; {} (the default) = every set
    matchLabels: { tier: team }
  # path: /workspace/my-app         # default /workspace/<name>
  project:                          # t3 project.update fields
    defaultThreadEnvMode: worktree
    autoPull: true
  settings:                         # the project's t3 setting overrides, as a whole
    branchNamePrefix: agent/
  # deletionPolicy: Archive         # Archive | Delete | Retain
  tasks:
    dependencies:                   # a t3 scheduled task; t3 runs it
      prompt: Check for outdated dependencies and open a PR for any that are behind.
      schedule: { type: fixed_time, timeOfDay: "03:00", weekdays: [1, 2, 3, 4, 5] }
      modelSelection: { instanceId: claudeAgent, model: claude-haiku-5-5 }  # t3's instance id, not the driver's name
      runtimeMode: full-access
      # placement: One              # One | EachEnvironment
```

`kubectl -n t3code get t3projects,t3environmentsets` shows where everything
stands; each resource's status lists every environment with its phase
(`Waiting`, `Cloning`, `Ready`, `Error`) and message.

## What it does

- **Projects**: on every environment of every set the selector matches, it
  clones the repository (or registers a checkout already there, or adopts a
  project added by hand at the same path), then applies `project` and
  `settings`. An environment the selector stops matching loses the project by
  `deletionPolicy`; deleting the T3Project does the same everywhere (a
  finalizer holds it until done). `Archive` keeps threads and files; `Delete`
  removes the project and its threads; `Retain` leaves it. Checkouts are never
  deleted from disk.
- **Failed clones**: the environment's entry turns `Error` with git's message,
  and is retried every 5 minutes. Fix `repository` and it starts over at
  once: the failed project, which has no files, is deleted and the new
  repository cloned.
- **Tasks**: `placement: One` puts the task on a single environment, which
  keeps it across pod restarts (its thread lives there); `EachEnvironment` on
  all, so it runs once per environment. A task's own `environmentSetSelector`
  narrows its project's.
- **Readiness**: pods that declare the readiness gate
  `t3code.derfred.com/content-ready` become Ready only once no project placed
  on them is still on its way, so a StatefulSet rollout waits for each pod's
  projects. An `Error` doesn't hold the gate, nor does a clone older than 15
  minutes.
- **When**: at once on a change (watches on its resources and the pods), every
  5 seconds while a clone is under way, and every 5 minutes as a safety net.
  Unchanged specs are re-applied hourly, which undoes edits made in t3's UI to
  what the resource manages.

## Requirements

- **t3** on every pod, listening on `T3CODE_PORT` (3773) on all addresses
  (`t3 serve --host 0.0.0.0`), reachable from the operator on the pod's IP.
- **A token per StatefulSet that its t3 servers accept**: see
  [Tokens](#tokens).
- **The readiness gate** in the StatefulSet's pod template, if you want
  rollouts to wait for projects:
  ```yaml
  readinessGates:
    - conditionType: t3code.derfred.com/content-ready
  ```
  Pods only become Ready once the operator has marked them, so the operator
  must be running. Services that should reach a pod before it's Ready (such as
  the one you connect through) want `publishNotReadyAddresses: true`.
- **Node 24** to run it from source; the image has it.

### Tokens

The operator calls t3's API with a bearer token, one per StatefulSet: a file
named after the StatefulSet, which `install.yaml` mounts from the keys of
Secret `t3code-operator-tokens`. The token needs t3's standard scopes. There
are two ways to get one that the pods accept.

**1. A token you choose, with a t3 that reads it from a file.** The fork
[derfred/t3code](https://github.com/derfred/t3code/tree/feat/server-auth-token-file)
adds `t3 serve --auth-token-file FILE` (or `T3CODE_AUTH_TOKEN_FILE`): t3
accepts the token in that file, any string of at least 32 characters, and
re-reads it when it changes. The image `ghcr.io/derfred/t3code`, used in the
[Example](#example), has it. Generate a token and give it to both sides, the
pods and the operator:

```sh
openssl rand -hex 32 > token
kubectl -n t3code create secret generic t3code-team-api-token --from-file=token=token
kubectl -n t3code create secret generic t3code-operator-tokens --from-file=t3code-team=token
rm token
```

Every pod of the set accepts the same token, so any number of replicas works,
and rotating is replacing both Secrets: neither t3 nor the operator needs a
restart. A Secret per set keeps a pod that reads its own token from reaching
any other set.

**2. A session token from upstream t3.** Any T3 Code (for example `t3` from
npm, as in [`e2e/t3.Dockerfile`](e2e/t3.Dockerfile)) issues bearer tokens
with `t3 auth session issue`. Run it in the pod, once it's up:

```sh
kubectl -n t3code exec t3code-team-0 -c t3 -- \
  t3 auth session issue --token-only --label t3code-operator --ttl 365d > token
kubectl -n t3code create secret generic t3code-operator-tokens --from-file=t3code-team=token
rm token
```

Leave out the `T3CODE_AUTH_TOKEN_FILE` variable and the `api-token` volume
from the StatefulSet. Such a token has limits the first way doesn't:

- It is signed with a key that t3 keeps in its data directory (`~/.t3`), so
  only the pod that issued it accepts it: one pod per StatefulSet
  (`replicas: 1`), and a persistent home volume, or a restart invalidates it.
- It expires: after 30 days by default, or the `--ttl` you give. Issue a new
  one before then, and replace the Secret:
  `kubectl -n t3code create secret generic t3code-operator-tokens --from-file=t3code-team=token --dry-run=client -o yaml | kubectl apply -f -`.

With several StatefulSets, `t3code-operator-tokens` holds one key per
StatefulSet (`--from-file` once for each). A set whose token is missing shows
up as an `Error` in its projects' status, and the rest go on.

## Configuration

By environment variable, which the Deployment sets: `NAMESPACE` (required),
`T3CODE_API_TOKEN_DIR` (required; one token file per StatefulSet, named after
it), `T3CODE_PORT` (3773), `RESYNC_INTERVAL_SECONDS` (300),
`CLONING_POLL_SECONDS` (5).

## Development

No dependencies: Node 24 runs the TypeScript in `src/` directly.

```sh
npm test       # unit tests
npm run e2e    # end-to-end; needs Docker and openssl
npm run render # deploy/install.yaml from deploy/jsonnet; needs jsonnet (or $JSONNET)
```

`deploy/install.yaml` is generated: change
`deploy/jsonnet` (the CRDs' schemas in `crds.libsonnet` follow what
`src/reconcile.ts` reads), then `npm run render`. `npm run render -- --check`
fails on a stale render, and on `deploy/jsonnet/version.json` disagreeing with
`package.json`.

CI (`.github/workflows/test.yaml`) runs all three checks on every push and
pull request.

The end-to-end test (`e2e/run.ts`) runs the **production image**, built from
the checkout, against a fake Kubernetes API server (`e2e/fake-apiserver.ts`:
HTTPS, watches, merge and strategic-merge patches, the status subresource,
finalizers) and a t3 server in Docker. The operator container gets exactly
what a cluster would give it: `KUBERNETES_SERVICE_HOST`/`PORT`, a
service-account token and CA at `/var/run/secrets/kubernetes.io/serviceaccount`,
and the t3 token file; nothing in the operator knows it's a test. The
scenario creates a set, its StatefulSet and pod, and a project with a task
through the API, then checks t3 itself: the clone, project fields, overrides,
the task, the readiness gate, a spec change arriving through the watch within
seconds, no writes once settled, and archive and cleanup on deletion.

```sh
npm run e2e -- --operator-image ghcr.io/derfred/t3code-operator:0.1.0   # a released image
npm run e2e -- --t3-image ghcr.io/derfred/t3code:2026.11.13              # another t3 build
```

Without Docker, `--operator process --t3-url URL --t3-token TOKEN --remote
REPO --workspace DIR` runs `src/main.ts` as a process against a t3 you already
have. The operator reads its service-account token from the standard path, so
that mode needs one there, as inside a pod.
