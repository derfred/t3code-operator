// The operator's CustomResourceDefinitions, in deploy/install.yaml.
// Their schemas follow what src/reconcile.ts reads; change both together.
local group = 't3code.derfred.com';

local string(description=null) = { type: 'string' } + (if description == null then {} else { description: description });
local enum(values, default=null, description=null) =
  string(description) { enum: values } + (if default == null then {} else { default: default });
// An object t3 defines: passed through to it as it is.
local opaque(description) = { type: 'object', description: description, 'x-kubernetes-preserve-unknown-fields': true };

// metav1.LabelSelector, as src/selector.ts implements it.
local labelSelector(description) = {
  type: 'object',
  description: description,
  properties: {
    matchLabels: { type: 'object', additionalProperties: { type: 'string' } },
    matchExpressions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['key', 'operator'],
        properties: {
          key: string(),
          operator: enum(['In', 'NotIn', 'Exists', 'DoesNotExist']),
          values: { type: 'array', items: string() },
        },
      },
    },
  },
};

// A namespaced kind at v1alpha1 with a status subresource. `spec` is the
// spec's schema; status is the operator's own and not validated.
local crd(kind, spec, columns) = {
  local plural = std.asciiLower(kind) + 's',
  apiVersion: 'apiextensions.k8s.io/v1',
  kind: 'CustomResourceDefinition',
  metadata: { name: plural + '.' + group },
  spec: {
    group: group,
    names: {
      kind: kind,
      listKind: kind + 'List',
      plural: plural,
      singular: std.asciiLower(kind),
    },
    scope: 'Namespaced',
    versions: [{
      name: 'v1alpha1',
      served: true,
      storage: true,
      subresources: { status: {} },
      additionalPrinterColumns: columns + [
        { name: 'Phase', type: 'string', jsonPath: '.status.phase' },
        { name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp' },
      ],
      schema: {
        openAPIV3Schema: {
          type: 'object',
          required: ['spec'],
          properties: {
            spec: spec { type: 'object' },
            status: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
          },
        },
      },
    }],
  },
};

local task = {
  type: 'object',
  required: ['prompt', 'schedule', 'modelSelection', 'runtimeMode'],
  properties: {
    prompt: string(),
    title: string('Default "<project>: <task>".'),
    enabled: { type: 'boolean', default: true },
    schedule: opaque("t3's schedule: {type: interval, everyMs} | {type: fixed_time, timeOfDay, weekdays?} | {type: once, runAt} | {type: webhook, ...}."),
    modelSelection: opaque('{instanceId, model, options?}, e.g. {instanceId: claudeAgent, model: claude-haiku-5-5}: the instance as t3 names it (its built-in ones are claudeAgent and codex).'),
    runtimeMode: enum(['approval-required', 'auto-accept-edits', 'auto', 'full-access']),
    interactionMode: enum(['default', 'plan'], default='default'),
    threadMode: enum(['new_thread', 'continue', 'fresh_session']),
    workspaceStrategy: opaque('Default {type: root}. Or {type: worktree, baseRef, branch?, startFromOrigin?}.'),
    placement: enum(
      ['One', 'EachEnvironment'],
      default='One',
      description='One: a single environment holds the task, and keeps it across pod restarts. EachEnvironment: every one does, so it runs once per environment.',
    ),
    environmentSetSelector: labelSelector("Narrows the project's environmentSetSelector. Default {}: no narrowing."),
  },
};

{
  environmentSets: crd(
    'T3EnvironmentSet',
    {
      required: ['statefulSet'],
      properties: {
        statefulSet: string('The StatefulSet whose pods are this set’s environments.'),
        auth: {
          type: 'object',
          description: 'How the operator authenticates to t3 on these pods. See README.md, Auth.',
          default: {},
          properties: {
            mode: enum(
              ['File', 'Session'],
              default='File',
              description='File: the token in the operator’s token file for this StatefulSet, which the pods accept through `t3 serve --auth-token-file` (the derfred/t3code fork). Session: each pod issues the operator a token with `t3 auth session issue`, run in it through pods/exec (any t3; the operator needs the pods/exec Role).',
            ),
            container: string('Session only: the container t3 runs in. Default t3.'),
            ttl: string('Session only: how long a token lives, such as 7d (s, m, h or d). Renewed halfway. Default 7d.') { pattern: '^[1-9][0-9]*[smhd]$' },
          },
        },
      },
    },
    [
      { name: 'StatefulSet', type: 'string', jsonPath: '.spec.statefulSet' },
      { name: 'Auth', type: 'string', jsonPath: '.spec.auth.mode' },
    ],
  ),

  projects: crd(
    'T3Project',
    {
      required: ['repository'],
      properties: {
        repository: string('Clone URL.'),
        path: string('Checkout path in the pod. Default /workspace/<name>.') { pattern: '^/' },
        title: string('Project title in t3. Default <name>.'),
        environmentSetSelector: labelSelector('T3EnvironmentSets to place the project on, on every one of their environments. Default {}: all of them.') { default: {} },
        project: opaque('Fields of t3 project.update: defaultModelSelection, defaultThreadEnvMode, autoPull, scripts, projectIcon, pinned, archived.'),
        settings: opaque("The project's whole set of t3 setting overrides (projectSettingsOverrides). Absent: left alone, or cleared if the operator set it before."),
        deletionPolicy: enum(
          ['Archive', 'Delete', 'Retain'],
          default='Archive',
          description='When the project is deleted, or leaves an environment: Archive keeps threads and files; Delete removes the project and all its threads; Retain leaves it as it is. Its tasks are removed in every case, and the checkout stays on disk.',
        ),
        tasks: {
          type: 'object',
          description: 't3 scheduled tasks of this project, by name. t3 runs them; the operator only places their definitions.',
          additionalProperties: task,
        },
      },
    },
    [{ name: 'Repository', type: 'string', jsonPath: '.spec.repository' }],
  ),
}
