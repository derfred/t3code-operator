# t3code-operator: design

How the operator decides what to do, and why it is built the way it is. Using
it: [README.md](../README.md).

## Problem

Each t3 server is an independent agent environment, with its own database,
logins and volumes. Set up by hand, every one of them means `git clone`,
registering the project, and clicking through Settings for overrides and
scheduled tasks, for every environment, with nothing recording what each one
should contain, and a rebuilt volume starting empty. The operator makes that
declarative: projects are Kubernetes resources, and the environments converge
on them.

## Vocabulary

- **Environment**: one t3 server, exactly as t3 uses the word. Here, one pod,
  with its own database, logins and volumes.
- **Environment set**: a StatefulSet and the environments it makes, all from
  one template, described to the operator by a `T3EnvironmentSet`.
- **Project**: a repository, its t3 settings and its tasks. A `T3Project`.
- **Task**: a t3 scheduled task. **t3 runs it** on its own schedule. The
  operator only decides which environments hold its definition.

## Scope

v1 manages projects (clone, register, settings, overrides, removal), their
scheduled tasks, and each environment's readiness. Out of scope for v1:

- **Deleting checkouts from disk.** t3 has no API for it. Removal unregisters
  or archives the project, and the files stay.
- **Provider logins** (`claude`, `codex login`). These stay with whatever sets
  up the pods.
- **Webhook signature secrets on tasks.** They would sit in plain text in a
  resource. Webhook schedules without a signature work.
- **Threads**, and anything else a user does inside a project.

## Who owns what

The StatefulSet owns the pods; the operator owns what's inside them. The
operator never renders, scales or restarts a StatefulSet.

- **You** (or your tooling) define the StatefulSets and one T3EnvironmentSet
  per StatefulSet. The pod spec stays wherever you review and deploy it, and
  the operator needs no rights over workloads.
- **The operator** reads the StatefulSet a T3EnvironmentSet names and finds
  its pods through the StatefulSet's own selector, so it depends on no naming
  convention, and talks to t3 on each pod's IP, so it needs no Service per pod.
- **Readiness flows back** through a pod readiness gate
  (`t3code.derfred.com/content-ready`), if the pods declare it: a pod is Ready
  only once the operator reports its projects in place, so a StatefulSet
  rollout moves to the next pod only after the previous one is set up.
  Services that should route to a pod regardless (the one people connect
  through) set `publishNotReadyAddresses`.

The alternative, the operator rendering the StatefulSet itself, would move
the whole pod spec into operator code and make the operator privileged; see
[Alternatives](#alternatives-considered).

## What t3 exposes

t3's own clients use a WebSocket RPC (Effect RPC, JSON frames on `/ws`). Plain
HTTP covers only the reads clients need before they connect, plus project
mutations for `t3 project add`.

| Operation | Transport | Method | Scope |
|---|---|---|---|
| List projects | HTTP | `GET /api/projects` | `orchestration:read` |
| Create, update or delete a project | HTTP | `POST /api/projects/mutate` | `orchestration:operate` (+`settings:write` for `scripts`) |
| Clone a URL and register it | RPC | `projectClone.start` | `source-control:write` |
| Check whether a checkout has files | RPC | `projects.listEntries` | `filesystem:read` |
| Project setting overrides | RPC | `server.updateSettings` (`projectSettingsOverrides`) | `settings:write` |
| Scheduled tasks | RPC | `scheduledTasks.upsert` / `.delete` | `orchestration:operate` |
| WebSocket ticket | HTTP | `POST /api/auth/websocket-ticket/rpc` | any session |

Two properties make a declarative layer simple:

- **The caller chooses the IDs.** Project and task IDs are chosen by the
  client, so stable IDs derived from resource names make every write an
  idempotent upsert.
- **Most writes are idempotent.** `scheduledTasks.delete` succeeds on a missing
  task, and a project's override set is replaced as a whole.

The operator uses the RPC rather than asking upstream for more HTTP endpoints.
The RPC is t3's real API, and duplicating it over HTTP would only be more
surface to keep in sync.

## Identity

- **IDs:** a project's ID is `k8s-<project>`; a task's is
  `k8s-<project>-<task>`. t3 never takes the ID of a deleted project again,
  so a project deleted before (`deletionPolicy: Delete`, or a failed clone
  started over) comes back as `k8s-<project>-<8 hex digits>`.
- **Finding the project** on an environment, in order:
  1. the ID recorded in that environment's status entry;
  2. `k8s-<project>`;
  3. a project already registered at the same path. This adopts a project
     added by hand, threads and all, and the status says so (`adopted
     existing project <id>`).
- **Status** is a list with one entry per environment, keyed by pod name.
  Ordinals are stable, so the name is too.

## Reconcile model

The operator is level-triggered: each pass reads everything and reconciles
everything, so a pass never depends on which event caused it. Passes run:

- **On a change**, within about a second. Watches on T3Projects,
  T3EnvironmentSets and the t3 pods wake the loop
  ([watch.ts](../src/watch.ts)): a spec edit, a
  new or restarted pod, a scale up or down. Several changes at once make one
  pass. The watches list once, then stream from that resourceVersion, resume
  where they left off when the API server ends them (every few minutes, by
  design), and list again when the version has expired. They keep no cache:
  they're only a wake-up signal.
- **Every 5 seconds while a clone is under way** (`cloningPollSeconds`). t3's
  progress is invisible to Kubernetes, so a finished clone is noticed by
  looking.
- **Every 5 minutes otherwise** (`resyncIntervalSeconds`), as a safety net.

The operator's own writes (status, finalizers, the pod gate) come back as
watch events too. They settle after one more pass, because status is written
only when it differs from what the API server holds, compared the way the
server stores it (keys sorted, nulls dropped).

Each pass:

1. **Observe.** Read every T3EnvironmentSet, its StatefulSet, and that
   StatefulSet's pods (by its own selector). An environment counts as up when
   its pod's `ContainersReady` is true; its `Ready` condition also waits on the
   gate the operator itself sets.
2. **Projects.** For each T3Project, place it on every environment of the sets
   it selects:
   1. **Resolve the project** (see [Identity](#identity)). If there's none,
      call `projectClone.start`, which registers the project and clones in the
      background. If the folder already has files ("not empty"), register the
      checkout as it is with `project.create`.
   2. **Wait for the clone.** Until that environment reports `Ready`, check
      the checkout has files (`projects.listEntries`, which doesn't list
      `.git`). For an empty folder, read t3's record of the clone (the first
      message of `subscribeProjectClones`):
      - **Failed:** the entry turns `Error` with git's message. From the same
        repository, `projectClone.retry` after 5 minutes. From a changed one,
        t3's retry would clone the old URL again: delete the project, which
        has no files and takes the failed clone and its folder with it, and
        clone the new repository under a fresh ID.
      - **Otherwise** it's a clone still running, or one a restart forgot.
        Call `projectClone.start` again: t3 reuses the project, or answers
        "already in progress", or "not empty" while git has written only
        `.git`.
   3. **Apply the spec:** `project.update` (`spec.project`, the title,
      `archived: false`), then `server.updateSettings` with
      `projectSettingsOverrides[id] = spec.settings`. This runs only when
      something changed: a hash of the desired state, the pod UID, or the last
      apply being over an hour old. The hourly resync repairs edits made in
      the UI without rewriting settings every pass.
   4. **Leaving an environment:** one the selector no longer matches loses
      the project by `deletionPolicy` (below). One whose pod is gone (scaled
      down, or its set removed) is just forgotten: its volumes keep the
      project, and bring it back if the pod returns.
3. **Tasks.** For each task, the **candidates** are the project's
   environments, narrowed by the task's own selector. The **eligible** ones
   are candidates where the project is Ready.
   - **`One`** (the default): a single environment holds the definition.
     - **Keeping it:** the environment that holds it keeps it for as long as
       it's a candidate, ready or not. A pod restart must not move a task,
       because its thread stays behind in the old environment's database.
     - **Moving it:** when the holder stops being a candidate (its pod is
       gone, or a selector changed), the task moves to an eligible
       environment, chosen by a hash of the task name. That's stable from pass
       to pass and spreads tasks across environments.
   - **`EachEnvironment`**: every eligible environment holds it, so it runs
     once per environment.

   Changes are written with `scheduledTasks.upsert`, under the same
   change-or-resync rule as projects. Holders that are no longer chosen get
   `scheduledTasks.delete`. A task with nowhere to go says so in
   `status.tasks`.
4. **Readiness.** For each environment, `content-ready` is true when no
   project placed there is still on its way: `Waiting`, or `Cloning` for up to
   15 minutes. An `Error` does not hold the gate: it's in status for a person
   to fix, and holding the gate on it would stall every later rollout. A
   failed clone is an `Error`; the 15-minute bound is for one that never
   finishes. The gate is written only when it changes.

**Status:**
- **T3Project:** `phase` (`Ready`, `Progressing`, `Error`, `Waiting`,
  `Deleting`), `environments[]` (each with `phase`, `message`, `projectId`,
  and the tasks it holds), and `tasks[]` (where each task is placed, or why
  it isn't).
- **T3EnvironmentSet:** each environment's readiness and projects.

`kubectl -n t3code get t3projects,t3environmentsets` shows both. Status is
written only when it changes.

**Ownership of settings:** `settings` replaces the project's entire override
set, so with it present the resource is the source of truth and edits in the
UI are undone at the next resync. Without `settings` the operator leaves the
overrides alone. If it set them before, it clears them, since removing the
field is the way back. `project` fields are merged, so fields the spec doesn't
mention stay as the user set them.

**Deletion and leaving an environment.** A finalizer
(`t3code.derfred.com/cleanup`) holds a deleted T3Project until every
environment it was on is cleaned up. An environment the selector stops
matching gets the same treatment. Its tasks are always removed; the project
follows `deletionPolicy`:

| deletionPolicy | Effect on the environment |
|---|---|
| `Archive` (default) | Archive the project and clear the overrides the operator set. Threads and files stay; selecting the environment again unarchives it. |
| `Delete` | `project.delete` with `force`: the project **and all its threads** go. Files stay. |
| `Retain` | The project stays as it is. |

- **A pod that isn't up** holds the removal until it is.
- **A pod that will never come back:** remove the finalizer by hand to let the
  resource go.

## Failure modes

| Situation | What happens |
|---|---|
| A pod is down or not up | That environment's entry is `Waiting`; the others proceed. |
| The clone fails (bad URL, no access, egress allowlist) | `Error` with git's message; the gate doesn't wait. Retried every 5 minutes from the same repository; a changed `repository` starts over at once, under a fresh project ID. |
| t3 rejects a field | That environment's entry is `Error` with t3's message. The gate stays open; the next pass retries. |
| The operator is down | Nothing changes in the environments. **New or restarted pods stay not-Ready, so a rollout stalls** , while the tailnet access stays up. On restart, one pass catches up. |
| The token is wrong, or t3 is older than `--auth-token-file` | Every environment is `Error: HTTP 401`. |
| t3 changes its RPC protocol | `/ws` answers 426 and every environment goes `Error`. The end-to-end test, run against a new t3 build (`npm run e2e -- --t3-image ...`), catches it before a rollout. |

## Alternatives considered

- **The operator renders the StatefulSet from a T3Environment.** One object per
  environment set, with owner references, sounds tidy. But the pod spec would
  move into operator code: security settings, init containers, sidecars,
  Services, Ingresses, network policies, secrets.
  - **Reviewability goes:** the StatefulSet would no longer be in your
    reviewed manifests, and GitOps tooling would no longer catch drift in it.
  - **Privilege grows:** the operator would need rights to create workloads,
    Ingresses and ExternalSecrets (which means vault access).
  - **Hard updates come with it:** the StatefulSet's immutable volume
    templates would become its problem.

  The readiness gate gives the feedback loop that was missing, without any of
  that.
- **A reconciler sidecar in every pod.** No CRDs and no RBAC, but no status
  you can query, no finalizers to undo what it did, and per-pod differences
  would need their own mapping.
- **Writing `settings.json` and the database directly.** That skips t3's
  validation and side effects.
- **A Go operator (kubebuilder).** Watches and caching for free, but a
  hand-kept copy of t3's RPC schemas in another language. TypeScript speaks
  t3's protocol as t3 does.
- **`@kubernetes/client-node`.** Typed objects and informers, but a large
  dependency tree for what is a handful of API calls here; the watch loop
  (`src/watch.ts`) is about a hundred lines. Worth it once reading everything
  per pass gets expensive.
- **More HTTP endpoints upstream.** That would duplicate the RPC.

## Later work

- **Checkout removal:** a `deletionPolicy: Purge`, which needs a t3 API to
  remove a project folder.
- **Clone errors in status:** subscribing to `projectClone.subscribe` would
  surface git's error.
- **Webhook tasks:** report each task's webhook URL in status, and take the
  signature secret from a Secret reference.
- **An informer cache** (`@kubernetes/client-node`), if the operator ever
  manages enough objects that reading everything per pass gets expensive.
