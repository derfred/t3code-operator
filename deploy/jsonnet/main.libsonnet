// The t3code operator's install manifests, as a jsonnet library: the source
// of deploy/install.yaml (`npm run render`), and what a Tanka setup vendors
// at a release tag (jsonnet-bundler, this directory).
//
//   local operator = import 't3code-operator/main.libsonnet';
//   local cfg = operator.config { namespace: 't3code' };
//   operator.crds + operator.objects(cfg)
//
// `crds` are cluster-scoped: apply them before anything that uses their
// kinds. `objects(cfg)` are namespaced, all in cfg.namespace, and hold no
// Secret: the API tokens are the caller's (see README.md, Requirements).
local crds = import 'crds.libsonnet';
local version = (import 'version.json').version;

{
  // The operator's release. The default image is the one built from it.
  version: version,

  config: {
    // Required: where the operator runs, and the t3 pods it manages.
    namespace: null,
    name: 't3code-operator',
    labels: { app: $.config.name },
    image: 'ghcr.io/derfred/t3code-operator:' + version,
    imagePullPolicy: 'IfNotPresent',

    // The API tokens, one per StatefulSet of t3 pods, each a token those
    // pods accept, mounted as <tokenDir>/<statefulSet>, where the operator
    // looks for it. By default all of them are keys of one Secret, named
    // after the StatefulSets:
    //   kubectl create secret generic t3code-operator-tokens --from-file=<statefulSet>=<file>
    // It is optional: the operator starts without it, and reports a set
    // whose token is missing.
    tokenSecret: $.config.name + '-tokens',
    // Or, instead, one Secret per StatefulSet, each holding its token under
    // tokenKey (a Secret per set can come from its own source, such as one
    // generated next to the set):
    //   [{ statefulSet: 't3code-team', secret: 't3code-api-token-team' }]
    tokens: [],
    tokenKey: 'token',
    tokenDir: '/etc/t3code/api',

    // t3's port on every pod.
    port: 3773,
    // A pass on every watched change; these timers cover what no watch
    // sees, inside t3. See README.md, "When".
    resyncIntervalSeconds: 300,
    cloningPollSeconds: 5,

    resources: {
      requests: { cpu: '10m', memory: '64Mi' },
      limits: { memory: '256Mi' },
    },
  },

  crds: [crds.environmentSets, crds.projects],

  // What the operator does in its namespace: its own kinds, the
  // StatefulSets they name, their pods, and the pods' content-ready
  // condition. No Secrets.
  rules: [
    {
      apiGroups: ['t3code.derfred.com'],
      resources: ['t3projects', 't3environmentsets'],
      verbs: ['get', 'list', 'watch', 'patch', 'update'],
    },
    {
      apiGroups: ['t3code.derfred.com'],
      resources: ['t3projects/status', 't3environmentsets/status'],
      verbs: ['get', 'patch', 'update'],
    },
    { apiGroups: ['apps'], resources: ['statefulsets'], verbs: ['get'] },
    { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: [''], resources: ['pods/status'], verbs: ['patch'] },
  ],

  objects(cfg):: (
    assert cfg.namespace != null : 't3code-operator: config.namespace is required';
    local metadata = { name: cfg.name, namespace: cfg.namespace, labels: cfg.labels };
    [
      {
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: metadata,
      },
      {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'Role',
        metadata: metadata,
        rules: $.rules,
      },
      {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'RoleBinding',
        metadata: metadata,
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: cfg.name },
        subjects: [{ kind: 'ServiceAccount', name: cfg.name, namespace: cfg.namespace }],
      },
      {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: metadata,
        spec: {
          replicas: 1,
          // Never two reconcilers at once, even during a rollout.
          strategy: { type: 'Recreate' },
          selector: { matchLabels: cfg.labels },
          template: {
            metadata: { labels: cfg.labels },
            spec: {
              serviceAccountName: cfg.name,
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 1000,
                runAsGroup: 1000,
                fsGroup: 1000,
                seccompProfile: { type: 'RuntimeDefault' },
              },
              containers: [{
                name: 'operator',
                image: cfg.image,
                imagePullPolicy: cfg.imagePullPolicy,
                env: [
                  { name: 'NAMESPACE', valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } } },
                  { name: 'T3CODE_API_TOKEN_DIR', value: cfg.tokenDir },
                  { name: 'T3CODE_PORT', value: std.toString(cfg.port) },
                  { name: 'RESYNC_INTERVAL_SECONDS', value: std.toString(cfg.resyncIntervalSeconds) },
                  { name: 'CLONING_POLL_SECONDS', value: std.toString(cfg.cloningPollSeconds) },
                ],
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ['ALL'] },
                },
                resources: cfg.resources,
                volumeMounts: [{ name: 'api-token', mountPath: cfg.tokenDir, readOnly: true }],
              }],
              volumes: [{
                name: 'api-token',
                // One file per StatefulSet, named after it. Without subPath,
                // so a rotated token reaches the operator without a restart.
                // 0440, group = fsGroup.
              } + (
                if std.length(cfg.tokens) == 0 then {
                  secret: { secretName: cfg.tokenSecret, optional: true, defaultMode: 288 },
                } else {
                  projected: {
                    defaultMode: 288,
                    sources: [
                      { secret: { name: t.secret, items: [{ key: cfg.tokenKey, path: t.statefulSet }] } }
                      for t in cfg.tokens
                    ],
                  },
                }
              )],
            },
          },
        },
      },
    ]
  ),
}
