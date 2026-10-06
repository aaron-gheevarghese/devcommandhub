#!/usr/bin/env bash
# DevCommandHub Kubernetes operations.
# Usage: k8s-ops.sh <deploy|rollback|scale|restart|logs|status> <service> <environment> [replicas] [tail]
#
# Runs against the current kubectl context. Used by:
#   - .github/workflows/ops.yml (kind cluster on the runner, DCH_EPHEMERAL=1)
#   - the backend's "kubernetes" executor (your local kind/minikube/remote cluster)
#
# Env:
#   KIND_CLUSTER     load locally built images into this kind cluster
#   DCH_EPHEMERAL=1  cluster is fresh: bootstrap missing deployments instead of failing
#   DCH_LOG_PREFIX=1 prefix all output with "DCH| " so the backend can pick it out of CI logs
#   IMAGE_TAG        image tag for deploys (default: short git SHA)
set -euo pipefail

if [[ "${DCH_LOG_PREFIX:-}" == "1" ]]; then
  exec 3>&1
  exec > >(while IFS= read -r line; do printf 'DCH| %s\n' "$line" >&3; done) 2>&1
  PREFIX_PID=$!
  # flush the prefixer before exiting so the last lines aren't lost
  trap 'exec 1>&- 2>&-; wait "$PREFIX_PID" 2>/dev/null || true' EXIT
fi

ACTION="${1:-}"
SERVICE="${2:-}"
ENVIRONMENT="${3:-development}"
REPLICAS="${4:-}"
TAIL="${5:-100}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROLLOUT_TIMEOUT="${ROLLOUT_TIMEOUT:-180s}"

die() { echo "❌ $*"; exit 1; }
step() { echo "▶ $*"; }

# ---------- validate inputs (they originate from natural-language commands) ----------
case "$ACTION" in
  deploy|rollback|scale|restart|logs|status) ;;
  *) die "Unknown action '$ACTION' (expected deploy|rollback|scale|restart|logs|status)" ;;
esac

case "$(echo "$ENVIRONMENT" | tr '[:upper:]' '[:lower:]')" in
  prod|production) ENVIRONMENT=production ;;
  stage|staging) ENVIRONMENT=staging ;;
  dev|development|local) ENVIRONMENT=development ;;
  test|testing) ENVIRONMENT=test ;;
  qa) ENVIRONMENT=qa ;;
  uat) ENVIRONMENT=uat ;;
  *) die "Unknown environment '$ENVIRONMENT'" ;;
esac
NS="dch-$ENVIRONMENT"

AVAILABLE="$(ls "$ROOT/k8s" | tr '\n' ' ')"
if [[ -n "$SERVICE" ]]; then
  [[ "$SERVICE" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || die "Invalid service name '$SERVICE'"
  [[ -d "$ROOT/k8s/$SERVICE" ]] || die "Unknown service '$SERVICE'. Available: $AVAILABLE"
elif [[ "$ACTION" != "status" ]]; then
  die "A service is required for $ACTION. Available: $AVAILABLE"
fi

if [[ "$ACTION" == "scale" ]]; then
  [[ "$REPLICAS" =~ ^[0-9]+$ ]] && (( REPLICAS <= 20 )) || die "Replicas must be an integer 0-20 (got '$REPLICAS')"
fi
[[ "$TAIL" =~ ^[0-9]+$ ]] || TAIL=100

command -v kubectl >/dev/null || die "kubectl not found"
kubectl cluster-info >/dev/null 2>&1 || die "No reachable Kubernetes cluster (kubectl context: $(kubectl config current-context 2>/dev/null || echo none))"

echo "Cluster: $(kubectl config current-context)  Namespace: $NS"
kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

TAG="${IMAGE_TAG:-$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || date +%s)}"

# ---------- helpers ----------
deployment_exists() { kubectl -n "$NS" get deployment "$SERVICE" >/dev/null 2>&1; }

build_image() { # <tag> <source dir>
  local tag="$1" src="$2" image="dch/$SERVICE:$1"
  command -v docker >/dev/null || die "docker not found (needed to build $image)"
  step "Building image $image"
  docker build -q --build-arg "APP_VERSION=$tag" -t "$image" "$src" >/dev/null
  if [[ -n "${KIND_CLUSTER:-}" ]]; then
    step "Loading $image into kind cluster '$KIND_CLUSTER'"
    kind load docker-image "$image" --name "$KIND_CLUSTER" >/dev/null
  fi
}

deploy_version() { # <tag> <source dir>
  local tag="$1" src="$2"
  build_image "$tag" "$src"
  step "Applying manifests for $SERVICE ($tag)"
  for f in "$ROOT/k8s/$SERVICE"/*.yaml; do
    sed "s|dch/$SERVICE:IMAGE_TAG|dch/$SERVICE:$tag|" "$f" | kubectl -n "$NS" apply -f -
  done
  kubectl -n "$NS" annotate deployment "$SERVICE" "kubernetes.io/change-cause=devcommandhub deploy $tag" --overwrite >/dev/null
  step "Waiting for rollout"
  kubectl -n "$NS" rollout status "deployment/$SERVICE" --timeout="$ROLLOUT_TIMEOUT"
}

# On a fresh (CI) cluster, create the deployment so the requested operation has something to act on.
# For rollback we deploy the previous commit first so there is a real revision to roll back to.
ensure_deployed() {
  deployment_exists && return 0
  [[ "${DCH_EPHEMERAL:-0}" == "1" ]] || die "deployment/$SERVICE not found in $NS. Run: deploy $SERVICE to $ENVIRONMENT"
  echo "ℹ️  Fresh cluster: bootstrapping $SERVICE before $ACTION"
  if [[ "$ACTION" == "rollback" ]]; then
    local prev_dir; prev_dir="$(mktemp -d)"
    if git -C "$ROOT" cat-file -e "HEAD~1:services/$SERVICE" 2>/dev/null; then
      git -C "$ROOT" archive "HEAD~1" "services/$SERVICE" | tar -x -C "$prev_dir"
      deploy_version "$(git -C "$ROOT" rev-parse --short HEAD~1)" "$prev_dir/services/$SERVICE"
    else
      deploy_version "$TAG-baseline" "$ROOT/services/$SERVICE"
    fi
  fi
  deploy_version "$TAG" "$ROOT/services/$SERVICE"
}

show_state() {
  kubectl -n "$NS" get deployment "$SERVICE" -o wide
  kubectl -n "$NS" get pods -l "app=$SERVICE" -o wide
}

# ---------- actions ----------
case "$ACTION" in
  deploy)
    deploy_version "$TAG" "$ROOT/services/$SERVICE"
    show_state
    echo "✅ Deployed $SERVICE:$TAG to $ENVIRONMENT"
    ;;

  scale)
    ensure_deployed
    step "Scaling $SERVICE to $REPLICAS replicas"
    kubectl -n "$NS" scale "deployment/$SERVICE" --replicas="$REPLICAS"
    kubectl -n "$NS" rollout status "deployment/$SERVICE" --timeout="$ROLLOUT_TIMEOUT"
    show_state
    ready="$(kubectl -n "$NS" get deployment "$SERVICE" -o jsonpath='{.status.readyReplicas}')"
    echo "✅ $SERVICE scaled to ${ready:-0}/$REPLICAS ready replicas in $ENVIRONMENT"
    ;;

  restart)
    ensure_deployed
    step "Restarting $SERVICE"
    kubectl -n "$NS" rollout restart "deployment/$SERVICE"
    kubectl -n "$NS" rollout status "deployment/$SERVICE" --timeout="$ROLLOUT_TIMEOUT"
    show_state
    echo "✅ $SERVICE restarted in $ENVIRONMENT"
    ;;

  rollback)
    ensure_deployed
    before="$(kubectl -n "$NS" get deployment "$SERVICE" -o jsonpath='{.spec.template.spec.containers[0].image}')"
    revisions="$(kubectl -n "$NS" rollout history "deployment/$SERVICE" | grep -cE '^[0-9]+' || true)"
    (( revisions >= 2 )) || die "No previous revision of $SERVICE in $ENVIRONMENT to roll back to"
    step "Rolling back $SERVICE (current image: $before)"
    kubectl -n "$NS" rollout undo "deployment/$SERVICE"
    kubectl -n "$NS" rollout status "deployment/$SERVICE" --timeout="$ROLLOUT_TIMEOUT"
    after="$(kubectl -n "$NS" get deployment "$SERVICE" -o jsonpath='{.spec.template.spec.containers[0].image}')"
    kubectl -n "$NS" rollout history "deployment/$SERVICE"
    echo "✅ Rolled back $SERVICE in $ENVIRONMENT: $before -> $after"
    ;;

  logs)
    ensure_deployed
    step "Last $TAIL log lines for $SERVICE"
    kubectl -n "$NS" logs -l "app=$SERVICE" --tail="$TAIL" --prefix --all-containers
    ;;

  status)
    if [[ -z "$SERVICE" ]]; then
      kubectl -n "$NS" get deployments,services,pods -o wide
    else
      ensure_deployed
      show_state
      kubectl -n "$NS" rollout history "deployment/$SERVICE"
      kubectl -n "$NS" rollout status "deployment/$SERVICE" --timeout=5s && echo "✅ $SERVICE is healthy in $ENVIRONMENT"
    fi
    ;;
esac
