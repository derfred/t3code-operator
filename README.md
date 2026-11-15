# t3code-operator

A Kubernetes operator for [T3 Code](https://github.com/pingdotgg/t3code) environments:

- **Projects**: it creates/updates the projects on every pod. You only connect to the pod once and the operator ensures it contains current clones. Using an `environmentSetSelector` you can control the placement.
- **Readiness**: pods (optionally) declare the readiness gate `t3code.derfred.com/content-ready` and become Ready only once all projects placed on them are present.
- **Tasks**: manage scheduled tasks via the kubernetes manifest.
- **Failed clones**: broken git urls show up as `Error` in the environment's entry.

The pods are managed by a StatefulSet, not the operator. Design and trade-offs: [docs/design.md](docs/design.md).

## Try it locally

With Docker, [kind](https://kind.sigs.k8s.io), kubectl and helm:

```sh
examples/quickstart/quickstart.sh
```

One command: a kind cluster, the t3 image built from source
([`examples/t3-image`](examples/t3-image/Dockerfile): t3 from the fork, Claude Code, uv), the
operator, one t3 pod ([`t3.yaml`](examples/quickstart/t3.yaml)), and a project
it clones there ([`project.yaml`](examples/quickstart/project.yaml)). The API
token comes from the [External Secrets Operator](https://external-secrets.io),
which rotates it every 5 minutes ([`tokens.yaml`](examples/quickstart/tokens.yaml)). It ends
with a link to open t3 on localhost; `--delete` removes it all. `examples/t3-image/Dockerfile` is also the place to start your own image.

## Install

```sh
kubectl apply -f https://raw.githubusercontent.com/derfred/t3code-operator/v0.1.0/deploy/install.yaml
```

The manifest [`deploy/install.yaml`](deploy/install.yaml) sets up the
namespace `t3code`, the two CustomResourceDefinitions, and the operator
(ServiceAccount, Role, RoleBinding, Deployment). The operator needs a token for each StatefulSet of t3 pods it manages, in Secret `t3code-operator-tokens` (see [Tokens](#tokens)).

For more customizability use the jsonnet library.  Vendor it at a release tag with jsonnet-bundler (`jb install github.com/derfred/t3code-operator/deploy/jsonnet@v0.1.0`), then:

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

### Example

An environment set with two pods with their own home & workspace volumes. Also a project at the specified repository is automatically created on the pods, even if they are scaled or recreated later.

```yaml
apiVersion: t3code.derfred.com/v1alpha1
kind: T3EnvironmentSet
metadata:
  name: team
  namespace: t3code
  labels: { tier: team }
spec:
  statefulSet: t3code-team          # its pods are this set's environments, see below
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

This requires a stateful set definition like this one:

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
      readinessGates:               # Optional: Ready once the operator has put the projects in place
        - conditionType: t3code.derfred.com/content-ready
      securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, runAsNonRoot: true }
      containers:
        - name: t3
          image: ghcr.io/derfred/t3code:2026.11.13-2 # Use your own image here, see examples/t3-image/Dockerfile
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

`kubectl -n t3code get t3projects,t3environmentsets` shows where everything
stands; each resource's status lists every environment with its phase
(`Waiting`, `Cloning`, `Ready`, `Error`) and message.

## Auth Tokens

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

To have tokens generated and rotated for you, use the
[External Secrets Operator](https://external-secrets.io): a `Password`
generator and an `ExternalSecret` with a `refreshInterval` write a fresh token
into `t3code-operator-tokens`, and the pods mount their key of that same
Secret, so both sides always read the same token.
[`examples/quickstart/tokens.yaml`](examples/quickstart/tokens.yaml) rotates
every 5 minutes; while the kubelet updates the mounted files (about a minute),
the operator's calls may be refused, and it simply tries again on its next
pass.

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
