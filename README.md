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

**Where it lives, for now.** This directory is self-contained: everything the
operator needs (source, tests, end-to-end test, Dockerfile, CRDs, install
manifests) is in it, and nothing in it refers outside it. It sits in
bugzoo-infrastructure until it gets a repository of its own; see
[Extracting](#extracting). Nothing in that repository deploys it yet: the
cluster wiring comes separately.

## Example

```yaml
apiVersion: t3code.derfred.com/v1alpha1
kind: T3EnvironmentSet
metadata:
  name: bugzoo
  namespace: t3code
  labels: { trust: personal }
spec:
  statefulSet: t3code-bugzoo        # its pods are this set's environments
---
apiVersion: t3code.derfred.com/v1alpha1
kind: T3Project
metadata:
  name: infra
  namespace: t3code
spec:
  repository: git@github.com:derfred/bugzoo-infrastructure.git
  environmentSetSelector:           # a LabelSelector; {} (the default) = every set
    matchLabels: { trust: personal }
  # path: /workspace/infra          # default /workspace/<name>
  project:                          # t3 project.update fields
    defaultThreadEnvMode: worktree
    autoPull: true
  settings:                         # the project's t3 setting overrides, as a whole
    branchNamePrefix: bz/
  # deletionPolicy: Archive         # Archive | Delete | Retain
  tasks:
    charts:                         # a t3 scheduled task; t3 runs it
      prompt: Run the chart check and open a PR for anything behind.
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

- **t3** on every pod, listening on `T3CODE_PORT` (3773), reachable from the
  operator on the pod's IP.
- **A token per StatefulSet that its t3 servers accept**, as a file named
  after the StatefulSet in `T3CODE_API_TOKEN_DIR`: for example the file they
  read with `t3 serve --auth-token-file` (in T3 Code releases from the version
  that adds it), or a session from `t3 auth session issue`. It needs t3's
  standard scopes. Separate tokens keep a pod that can read its own from
  reaching any other set; one token for all of them works too, mounted once
  per set. `deploy/operator.yaml` mounts them as a projected volume.
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

## Install

With kubectl, from the rendered manifests:

```sh
kubectl apply -f deploy/crds.yaml
kubectl apply -f deploy/operator.yaml   # edit its namespace and tokens first; see the file
```

With jsonnet (Tanka, for one), from the library they are rendered from,
`deploy/jsonnet`. Vendor it at a release tag with jsonnet-bundler (`jb install
<repo>/deploy/jsonnet@vX.Y.Z`), then:

```jsonnet
local operator = import 't3code-operator/main.libsonnet';
local cfg = operator.config {
  namespace: 't3code',
  // One per StatefulSet of t3 pods: the Secret with a token they accept.
  tokens: [{ statefulSet: 't3code-bugzoo', secret: 't3code-api-token-bugzoo' }],
};
operator.crds + operator.objects(cfg)
```

`crds` are cluster-scoped and must exist before anything using their kinds is
applied. `objects(cfg)` is the ServiceAccount, Role, RoleBinding and
Deployment in `cfg.namespace`; `rules` is the Role's rules on their own.
`config` documents every field; the default image is the release's own.

Configuration is by environment variable: `NAMESPACE` (required; the
Deployment sets it), `T3CODE_API_TOKEN_DIR` (required; one token
file per StatefulSet, named after it), `T3CODE_PORT` (3773),
`RESYNC_INTERVAL_SECONDS` (300), `CLONING_POLL_SECONDS` (5).

## Development

No dependencies: Node 24 runs the TypeScript in `src/` directly.

```sh
npm test       # unit tests
npm run e2e    # end-to-end; needs Docker and openssl
npm run render # deploy/*.yaml from deploy/jsonnet; needs jsonnet (or $JSONNET)
```

`deploy/crds.yaml` and `deploy/operator.yaml` are generated: change
`deploy/jsonnet` (the CRDs' schemas in `crds.libsonnet` follow what
`src/reconcile.ts` reads), then `npm run render`. `npm run render -- --check`
fails on a stale render, and on `deploy/jsonnet/version.json` disagreeing with
`package.json`.

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

## Extracting

Moving the operator to a repository of its own:

1. Move this directory's contents to the new repository's root.
2. CI: `npm test`, `npm run render -- --check` and `npm run e2e` on every
   push (in bugzoo-infrastructure, the `operator` job of `test.yaml` and
   `t3code-operator-e2e.yaml`).
3. Release: on a `vX.Y.Z` tag matching `package.json`'s version, build the
   image, run `npm run e2e -- --operator-image <it>`, and push it, for example
   to `ghcr.io/<owner>/t3code-operator:X.Y.Z`. The library at that tag
   defaults to that image.
4. In bugzoo-infrastructure: vendor `deploy/jsonnet` from the new repository
   at the release tag (a git source in `jsonnetfile.json` instead of the local
   one), and run the released image instead of the source in a ConfigMap.
