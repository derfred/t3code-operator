#!/usr/bin/env bash
# The operator, end to end, on your machine, in one command: a kind cluster,
# the t3 image built from examples/t3-image, the operator, one t3 pod, and a project
# the operator clones onto it. It ends with a link to t3 on localhost.
#
#   examples/quickstart/quickstart.sh
#   examples/quickstart/quickstart.sh --delete      # remove it all
#
# Options:
#   --repository URL        the project to clone (default: this repository)
#   --operator-from-source  run the operator built from this checkout, not
#                           the released image
#   --no-forward            set up, print how to connect, and exit
#   --delete                delete the cluster and exit
#
# What it applies, next to this script: t3.yaml (the t3 pod) and
# project.yaml (what the operator puts on it), plus deploy/install.yaml.
#
# Needs docker (running), kind and kubectl. Re-running it is safe: it reuses
# the cluster and the token, and rolls the pod onto a changed image. The
# first build compiles t3 from source: a few minutes.
set -eEuo pipefail

cluster=${CLUSTER:-t3code-quickstart}
ns=t3code
pod=t3code-quickstart-0
repository=https://github.com/derfred/t3code-operator.git
from_source=false
forward=true
port=${PORT:-3773}

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)

usage() { sed -n '2,/^set -eEuo/{/^set -eEuo/d;s/^# \{0,1\}//;p;}' "$0"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --repository) repository=${2:?--repository needs a URL}; shift 2 ;;
    --operator-from-source) from_source=true; shift ;;
    --no-forward) forward=false; shift ;;
    --delete) delete=true; shift ;;
    -h | --help) usage; exit ;;
    *) echo "unknown option $1" >&2; usage >&2; exit 2 ;;
  esac
done

# ─── what it needs ───────────────────────────────────────────────────────────
missing=()
hint() {
  case "$1" in
    docker) echo "  docker   https://docs.docker.com/get-docker/" ;;
    kind) echo "  kind     https://kind.sigs.k8s.io/docs/user/quick-start/#installation  (brew install kind)" ;;
    kubectl) echo "  kubectl  https://kubernetes.io/docs/tasks/tools/  (brew install kubectl)" ;;
    openssl) echo "  openssl  your package manager's openssl" ;;
  esac
}
for tool in docker kind kubectl openssl; do
  command -v "$tool" > /dev/null || missing+=("$tool")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "quickstart needs these on the PATH, and is missing: ${missing[*]}" >&2
  for tool in "${missing[@]}"; do hint "$tool" >&2; done
  exit 1
fi
if ! docker info > /dev/null 2>&1; then
  echo "docker is installed, but its daemon isn't reachable: start Docker (Desktop) and try again." >&2
  exit 1
fi

if [ "${delete:-false}" = true ]; then
  kind delete cluster --name "$cluster"
  exit
fi

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
k() { kubectl --context "kind-$cluster" "$@"; }
# A manifest next to this script, its ${NAME} placeholders filled in.
render() { # render FILE NAME=VALUE...
  local file=$1 args=() kv name value
  shift
  for kv in "$@"; do
    name=${kv%%=*} value=${kv#*=}
    value=${value//\\/\\\\} value=${value//|/\\|} value=${value//&/\\&}
    args+=(-e "s|\${$name}|$value|g")
  done
  sed "${args[@]}" "$here/$file"
}

on_error() {
  echo >&2
  echo "Something went wrong. What the cluster says:" >&2
  k -n "$ns" get t3environmentsets,t3projects,pods -o wide >&2 2>/dev/null || true
  k -n "$ns" get t3projects -o jsonpath='{range .items[*]}{.metadata.name}: {.status.environments}{"\n"}{end}' >&2 2>/dev/null || true
  k -n "$ns" logs deploy/t3code-operator --tail 30 >&2 2>/dev/null || true
}
trap on_error ERR

# ─── the cluster ─────────────────────────────────────────────────────────────
step "Cluster: kind $cluster"
if kind get clusters 2>/dev/null | grep -qx "$cluster"; then
  echo "reusing it"
else
  kind create cluster --name "$cluster" --wait 120s
fi

# Built, tagged by content (so a changed image rolls the pod on a re-run),
# and loaded into kind. Prints the tag.
build() { # build NAME CONTEXT
  local id
  docker build -t "$1" "$2" >&2
  id=$(docker image inspect --format '{{.Id}}' "$1" | sed 's/^sha256://' | cut -c1-12)
  docker tag "$1" "$1:$id"
  kind load docker-image --name "$cluster" "$1:$id" >&2
  echo "$1:$id"
}

# ─── the t3 image ────────────────────────────────────────────────────────────
step "t3 image: examples/t3-image (t3 from the derfred/t3code fork, Claude Code, uv)"
image=$(build quickstart/t3 "$root/examples/t3-image")
echo "built $image"

# ─── the token ───────────────────────────────────────────────────────────────
# Before the operator, so it starts with its token rather than waiting for
# the kubelet to fill in its optional Secret. Kept across re-runs.
step "Token: one for the t3 pod and the operator"
k create namespace "$ns" --dry-run=client -o yaml | k apply -f -
token_file=$(mktemp)
trap 'rm -f "$token_file"' EXIT
if ! k -n "$ns" get secret t3code-quickstart-api-token -o jsonpath='{.data.token}' 2>/dev/null |
     base64 --decode > "$token_file" || [ ! -s "$token_file" ]; then
  openssl rand -hex 32 > "$token_file"
fi
k -n "$ns" create secret generic t3code-quickstart-api-token --from-file=token="$token_file" \
  --dry-run=client -o yaml | k apply -f -
k -n "$ns" create secret generic t3code-operator-tokens --from-file=t3code-quickstart="$token_file" \
  --dry-run=client -o yaml | k apply -f -

# ─── the operator ────────────────────────────────────────────────────────────
step "Operator: deploy/install.yaml"
k apply -f "$root/deploy/install.yaml"
if $from_source; then
  operator_image=$(build quickstart/operator "$root")
  k -n "$ns" set image deploy/t3code-operator operator="$operator_image"
  k -n "$ns" patch deploy/t3code-operator --type=json \
    -p '[{"op":"replace","path":"/spec/template/spec/containers/0/imagePullPolicy","value":"Never"}]'
fi
k wait --for=condition=Established --timeout=60s \
  crd/t3projects.t3code.derfred.com crd/t3environmentsets.t3code.derfred.com

# ─── the t3 pod and its project ──────────────────────────────────────────────
step "t3 pod (t3.yaml), environment set and project (project.yaml)"
render t3.yaml IMAGE="$image" | k apply -f -
render project.yaml REPOSITORY="$repository" | k apply -f -

step "Waiting: the operator, then the pod (Ready once the project is cloned)"
k -n "$ns" rollout status deploy/t3code-operator --timeout=180s
k -n "$ns" rollout status statefulset/t3code-quickstart --timeout=600s
k -n "$ns" wait --for=condition=Ready "pod/$pod" --timeout=600s
k -n "$ns" get t3environmentsets,t3projects

# ─── t3 ──────────────────────────────────────────────────────────────────────
step "t3"
pair=$(k -n "$ns" exec "$pod" -c t3 -- \
  t3 auth pairing create --base-url "http://localhost:$port" --label quickstart --ttl 1h |
  sed -n 's/^Pair URL: //p')
cat <<EOF
The project is on the pod, at /workspace/quickstart. Open t3 at

  $pair

(a one-time link, valid for an hour), and log in to Claude there to start
threads. Then try:
  kubectl --context kind-$cluster -n $ns get t3projects -o yaml       # where it stands
  kubectl --context kind-$cluster -n $ns edit t3project quickstart    # change it; watch t3 follow
  examples/quickstart/quickstart.sh --delete                          # remove it all
EOF

if $forward; then
  echo
  echo "Forwarding localhost:$port to the pod; Ctrl-C to stop (re-run the script to start again)."
  k -n "$ns" port-forward "pod/$pod" "$port:3773"
else
  echo
  echo "To connect: kubectl --context kind-$cluster -n $ns port-forward pod/$pod $port:3773"
fi
