#!/usr/bin/env bash
# The operator, end to end, on your machine, in one command: a kind cluster,
# a t3 image built from images/t3, the operator, one t3 pod, and a project
# the operator clones onto it. Then it opens t3 for you on localhost.
#
#   examples/quickstart.sh                          # minimal t3 image
#   examples/quickstart.sh --dockerfile examples/Dockerfile   # plus Node and Claude Code
#   examples/quickstart.sh --delete                 # remove the cluster
#
# Options:
#   --dockerfile FILE       also build FILE FROM the minimal image (as
#                           --build-arg BASE), and run that instead
#   --repository URL        the project to clone (default: this repository)
#   --operator-from-source  run the operator built from this checkout, not
#                           the released image
#   --no-forward            set up, print how to connect, and exit
#   --delete                delete the cluster and exit
#
# Needs docker, kind (https://kind.sigs.k8s.io) and kubectl. Re-running it is
# safe: it reuses the cluster and the token, and rolls the pod onto a new
# image. The first build of images/t3 compiles t3 from source: a few minutes.
set -eEuo pipefail

cluster=${CLUSTER:-t3code-quickstart}
ns=t3code
set_name=t3code-quickstart
repository=https://github.com/derfred/t3code-operator.git
dockerfile=
from_source=false
forward=true
port=${PORT:-3773}

while [ $# -gt 0 ]; do
  case "$1" in
    --dockerfile) dockerfile=$2; shift 2 ;;
    --repository) repository=$2; shift 2 ;;
    --operator-from-source) from_source=true; shift ;;
    --no-forward) forward=false; shift ;;
    --delete) kind delete cluster --name "$cluster"; exit ;;
    -h | --help) sed -n '2,/^set -eEuo/{/^set -eEuo/d;s/^# \{0,1\}//;p;}' "$0"; exit ;;
    *) echo "unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
done

root=$(cd "$(dirname "$0")/.." && pwd)
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
for tool in docker kind kubectl openssl; do
  command -v "$tool" > /dev/null || { echo "quickstart needs $tool on the PATH" >&2; exit 1; }
done
k() { kubectl --context "kind-$cluster" "$@"; }

on_error() {
  echo
  echo "Something went wrong. What the cluster says:" >&2
  k -n "$ns" get t3environmentsets,t3projects,pods -o wide 2>/dev/null || true
  k -n "$ns" get t3projects -o jsonpath='{range .items[*]}{.metadata.name}: {.status.environments}{"\n"}{end}' 2>/dev/null || true
  k -n "$ns" logs deploy/t3code-operator --tail 30 2>/dev/null || true
}
trap on_error ERR

step "Cluster: kind $cluster"
if kind get clusters 2>/dev/null | grep -qx "$cluster"; then
  echo "reusing it"
else
  kind create cluster --name "$cluster" --wait 120s
fi

# Tagged by content, so a changed image rolls the pod on a re-run.
build() { # build TAG [docker build args...]
  local tag=$1; shift
  docker build -t "$tag" "$@" >&2
  local id
  id=$(docker image inspect --format '{{.Id}}' "$tag" | sed 's/^sha256://' | cut -c1-12)
  docker tag "$tag" "${tag%:*}:$id"
  kind load docker-image --name "$cluster" "${tag%:*}:$id" >&2
  echo "${tag%:*}:$id"
}

step "t3 image: images/t3 (t3 from the derfred/t3code fork)"
image=$(build quickstart/t3:base "$root/images/t3")
if [ -n "$dockerfile" ]; then
  step "t3 image: $dockerfile, FROM it"
  image=$(build quickstart/t3:custom --build-arg BASE="$image" -f "$dockerfile" "$(dirname "$dockerfile")")
fi
echo "running $image"

# Before the operator, so it starts with its token rather than waiting for
# the kubelet to fill in the optional Secret.
step "Token: one for the t3 pod and the operator"
k create namespace "$ns" --dry-run=client -o yaml | k apply -f -
token_file=$(mktemp)
trap 'rm -f "$token_file"' EXIT
if ! k -n "$ns" get secret "$set_name-api-token" -o jsonpath='{.data.token}' 2>/dev/null | base64 --decode > "$token_file" \
   || [ ! -s "$token_file" ]; then
  openssl rand -hex 32 > "$token_file"
fi
k -n "$ns" create secret generic "$set_name-api-token" --from-file=token="$token_file" --dry-run=client -o yaml | k apply -f -
k -n "$ns" create secret generic t3code-operator-tokens --from-file="$set_name=$token_file" --dry-run=client -o yaml | k apply -f -

step "Operator: deploy/install.yaml"
k apply -f "$root/deploy/install.yaml"
if $from_source; then
  operator_image=$(build quickstart/operator:dev "$root")
  k -n "$ns" set image deploy/t3code-operator operator="$operator_image"
  k -n "$ns" patch deploy/t3code-operator --type=json \
    -p '[{"op":"replace","path":"/spec/template/spec/containers/0/imagePullPolicy","value":"Never"}]'
fi
k wait --for=condition=Established --timeout=60s crd/t3projects.t3code.derfred.com crd/t3environmentsets.t3code.derfred.com

step "t3 pod, environment set and project"
k apply -f - <<EOF
apiVersion: v1
kind: Service
metadata: { name: $set_name, namespace: $ns }
spec:
  clusterIP: None
  publishNotReadyAddresses: true
  selector: { app: $set_name }
  ports: [{ name: http, port: 3773 }]
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: $set_name, namespace: $ns }
spec:
  serviceName: $set_name
  replicas: 1
  selector: { matchLabels: { app: $set_name } }
  template:
    metadata: { labels: { app: $set_name } }
    spec:
      readinessGates:
        - conditionType: t3code.derfred.com/content-ready
      securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, runAsNonRoot: true }
      containers:
        - name: t3
          image: $image
          imagePullPolicy: Never   # loaded into kind, not pulled
          command: [t3, serve, --host, 0.0.0.0, --port, "3773"]
          env:
            - { name: T3CODE_AUTH_TOKEN_FILE, value: /etc/t3code/api/token }
          ports: [{ name: http, containerPort: 3773 }]
          readinessProbe: { tcpSocket: { port: 3773 } }
          volumeMounts:
            - { name: api-token, mountPath: /etc/t3code/api, readOnly: true }
            - { name: home, mountPath: /home/node }
            - { name: workspace, mountPath: /workspace }
      volumes:
        - name: api-token
          secret: { secretName: $set_name-api-token }
  volumeClaimTemplates:
    - metadata: { name: home }
      spec: { accessModes: [ReadWriteOnce], resources: { requests: { storage: 1Gi } } }
    - metadata: { name: workspace }
      spec: { accessModes: [ReadWriteOnce], resources: { requests: { storage: 2Gi } } }
---
apiVersion: t3code.derfred.com/v1alpha1
kind: T3EnvironmentSet
metadata: { name: quickstart, namespace: $ns, labels: { tier: quickstart } }
spec:
  statefulSet: $set_name
---
apiVersion: t3code.derfred.com/v1alpha1
kind: T3Project
metadata: { name: quickstart, namespace: $ns }
spec:
  repository: $repository
  environmentSetSelector: { matchLabels: { tier: quickstart } }
  project: { pinned: true }
EOF

step "Waiting: the operator, then the pod (Ready once the project is cloned)"
k -n "$ns" rollout status deploy/t3code-operator --timeout=180s
k -n "$ns" rollout status statefulset/"$set_name" --timeout=600s
k -n "$ns" wait --for=condition=Ready pod/"$set_name-0" --timeout=600s
k -n "$ns" get t3environmentsets,t3projects

step "t3"
pair=$(k -n "$ns" exec "$set_name-0" -c t3 -- \
  t3 auth pairing create --base-url "http://localhost:$port" --label quickstart --ttl 1h |
  sed -n 's/^Pair URL: //p')
cat <<EOF
The project is on the pod, at /workspace/quickstart. Open t3 at

  $pair

(a one-time link, valid for an hour). Try:
  kubectl --context kind-$cluster -n $ns get t3projects -o yaml       # where it stands
  kubectl --context kind-$cluster -n $ns edit t3project quickstart    # change it; watch t3 follow
  examples/quickstart.sh --delete                                     # remove it all
EOF

if $forward; then
  echo
  echo "Forwarding localhost:$port to the pod; Ctrl-C to stop (re-run the script to start again)."
  k -n "$ns" port-forward "pod/$set_name-0" "$port:3773"
else
  echo
  echo "To connect: kubectl --context kind-$cluster -n $ns port-forward pod/$set_name-0 $port:3773"
fi
