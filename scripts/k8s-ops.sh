#!/usr/bin/env bash
# DevCommandHub Kubernetes operations, driven by the target repo's .devcommandhub.yml.
# Usage: k8s-ops.sh <deploy|rollback|scale|restart|logs|status> <service> <environment> [replicas] [tail]
#
# Runs against the current kubectl context. Used by:
#   - .github/workflows/dch-ops.yml (reusable workflow called from any repo)
#   - the backend's "kubernetes" executor (local cluster)
#
# Env:
#   DCH_REPO_ROOT    repo containing .devcommandhub.yml (default: current directory)
#   DCH_REGISTRY     push images here (e.g. ghcr.io/owner/repo); otherwise images stay local
#   KIND_CLUSTER     load locally built images into this kind cluster
#   DCH_EPHEMERAL=1  cluster is fresh: bootstrap missing deployments instead of failing
#   DCH_LOG_PREFIX=1 prefix all output with "DCH| " so the backend can pick it out of CI logs
#   IMAGE_TAG        image tag for deploys (default: short git SHA)
#
# .devcommandhub.yml:
#   services:
#     api:
#       context: services/api   # docker build context (or `image: nginx:1.27` to skip building)
#       dockerfile: Dockerfile  # relative to context (default Dockerfile)
#       manifests: k8s/api      # optional dir applied on deploy; `image: DCH_IMAGE` is replaced
#       deployment: api         # default: service name
#       port: 8080              # container port (services without manifests)
#       command: uvicorn app:app --port 8080   # start command (services without manifests)
#       env: { LOG_LEVEL: info }               # plain env vars (services without manifests)
#   environments:
#     staging: { namespace: my-staging }   # default namespace: dch-<environment>
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

ROOT="$(cd "${DCH_REPO_ROOT:-$(pwd)}" && pwd)"
CONFIG="$ROOT/.devcommandhub.yml"
ROLLOUT_TIMEOUT="${ROLLOUT_TIMEOUT:-180s}"

die() { echo "❌ $*" >&2; exit 1; }
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

[[ -f "$CONFIG" ]] || die "No .devcommandhub.yml in $ROOT. Run \"DevCommandHub: Set Up This Repo\" in VS Code."
command -v yq >/dev/null || die "yq is required to read .devcommandhub.yml"
cfg() { yq -r "$1 // \"\"" "$CONFIG"; }

AVAILABLE="$(yq -r '.services // {} | keys | join(" ")' "$CONFIG")"
if [[ -n "$SERVICE" ]]; then
  [[ "$SERVICE" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || die "Invalid service name '$SERVICE'"
  [[ "$(yq -r ".services | has(\"$SERVICE\")" "$CONFIG")" == "true" ]] || die "Unknown service '$SERVICE'. Available: $AVAILABLE"
elif [[ "$ACTION" != "status" ]]; then
  die "A service is required for $ACTION. Available: $AVAILABLE"
fi

if [[ "$ACTION" == "scale" ]]; then
  [[ "$REPLICAS" =~ ^[0-9]+$ ]] && (( REPLICAS <= 50 )) || die "Replicas must be an integer 0-50 (got '$REPLICAS')"
fi
[[ "$TAIL" =~ ^[0-9]+$ ]] || TAIL=100

NS="$(cfg ".environments.$ENVIRONMENT.namespace")"
NS="${NS:-dch-$ENVIRONMENT}"

if [[ -n "$SERVICE" ]]; then
  S=".services.\"$SERVICE\""
  DEPLOY="$(cfg "$S.deployment")"; DEPLOY="${DEPLOY:-$SERVICE}"
  CONTEXT="$(cfg "$S.context")"
  DOCKERFILE="$(cfg "$S.dockerfile")"; DOCKERFILE="${DOCKERFILE:-Dockerfile}"
  PREBUILT="$(cfg "$S.image")"
  MANIFESTS="$(cfg "$S.manifests")"
  PORT="$(cfg "$S.port")"
  COMMAND="$(cfg "$S.command")"
  [[ -n "$CONTEXT" || -n "$PREBUILT" ]] || die "Service '$SERVICE' needs either 'context' or 'image' in .devcommandhub.yml"
fi

command -v kubectl >/dev/null || die "kubectl not found"
kubectl cluster-info >/dev/null 2>&1 || die "No reachable Kubernetes cluster (kubectl context: $(kubectl config current-context 2>/dev/null || echo none))"

echo "Cluster: $(kubectl config current-context)  Namespace: $NS"
kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

TAG="${IMAGE_TAG:-$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || date +%s)}"

# ---------- helpers ----------
deployment_exists() { kubectl -n "$NS" get deployment "$DEPLOY" >/dev/null 2>&1; }
current_image() { kubectl -n "$NS" get deployment "$DEPLOY" -o jsonpath='{.spec.template.spec.containers[0].image}'; }

# Build (or reuse) the image for a source dir and print its reference on the last line
build_image() { # <tag> <context dir>
  local tag="$1" ctx="$2" image
  if [[ -n "$PREBUILT" ]]; then echo "$PREBUILT"; return; fi
  if [[ -n "${DCH_REGISTRY:-}" ]]; then image="$DCH_REGISTRY/$SERVICE:$tag"; else image="dch/$SERVICE:$tag"; fi
  command -v docker >/dev/null || die "docker not found (needed to build $image)"
  step "Building image $image" >&2
  docker build -q --build-arg "APP_VERSION=$tag" -f "$ctx/$DOCKERFILE" -t "$image" "$ctx" >/dev/null
  if [[ -n "${DCH_REGISTRY:-}" ]]; then
    step "Pushing $image" >&2
    docker push -q "$image" >/dev/null
  elif [[ -n "${KIND_CLUSTER:-}" ]]; then
    step "Loading $image into kind cluster '$KIND_CLUSTER'" >&2
    kind load docker-image "$image" --name "$KIND_CLUSTER" >/dev/null
  fi
  echo "$image"
}

# Deployment for services without manifests, built from .devcommandhub.yml (command, env, port).
# replicas is omitted so re-applying keeps the current scale.
generated_deployment() { # <image>
  local env_json
  env_json="$(yq -o=json "$S.env // {} | to_entries | map({\"name\": .key, \"value\": (.value | tostring)})" "$CONFIG")"
  jq -n --arg name "$DEPLOY" --arg image "$1" --arg cmd "$COMMAND" --arg port "$PORT" --argjson env "$env_json" '{
    apiVersion: "apps/v1", kind: "Deployment",
    metadata: { name: $name, labels: { app: $name, "app.kubernetes.io/managed-by": "devcommandhub" } },
    spec: {
      revisionHistoryLimit: 10,
      selector: { matchLabels: { app: $name } },
      template: {
        metadata: { labels: { app: $name } },
        spec: { containers: [ ({ name: $name, image: $image, imagePullPolicy: "IfNotPresent", env: $env }
          + (if $cmd != "" then { command: ["sh", "-c", $cmd] } else {} end)
          + (if $port != "" then { ports: [ { containerPort: ($port | tonumber) } ] } else {} end)) ] }
      }
    }
  }'
}

deploy_version() { # <tag> <context dir>
  local tag="$1" ctx="$2" image container
  image="$(build_image "$tag" "$ctx" | tail -n1)"
  if [[ -n "$MANIFESTS" ]]; then
    [[ -e "$ROOT/$MANIFESTS" ]] || die "manifests path '$MANIFESTS' not found"
    step "Applying manifests in $MANIFESTS"
    while IFS= read -r f; do
      sed "s|DCH_IMAGE|$image|g" "$f" | kubectl -n "$NS" apply -f -
    done < <(find "$ROOT/$MANIFESTS" -type f \( -name '*.yaml' -o -name '*.yml' \) | sort)
  fi
  if [[ -z "$MANIFESTS" ]]; then
    step "Applying deployment $DEPLOY"
    generated_deployment "$image" | kubectl -n "$NS" apply -f -
    if [[ -n "$PORT" ]] && ! kubectl -n "$NS" get service "$DEPLOY" >/dev/null 2>&1; then
      kubectl -n "$NS" expose deployment "$DEPLOY" --port=80 --target-port="$PORT"
    fi
  fi
  container="$(kubectl -n "$NS" get deployment "$DEPLOY" -o jsonpath='{.spec.template.spec.containers[0].name}')"
  if [[ "$(current_image)" != "$image" ]]; then
    step "Setting image $container=$image"
    kubectl -n "$NS" set image "deployment/$DEPLOY" "$container=$image"
  fi
  kubectl -n "$NS" annotate deployment "$DEPLOY" "kubernetes.io/change-cause=devcommandhub deploy $tag" --overwrite >/dev/null
  step "Waiting for rollout"
  kubectl -n "$NS" rollout status "deployment/$DEPLOY" --timeout="$ROLLOUT_TIMEOUT"
}

# On a fresh (sandbox) cluster, create the deployment so the requested operation has something to act on.
# For rollback we deploy the previous commit first so there is a real revision to roll back to.
ensure_deployed() {
  deployment_exists && return 0
  [[ "${DCH_EPHEMERAL:-0}" == "1" ]] || die "deployment/$DEPLOY not found in $NS. Run: deploy $SERVICE to $ENVIRONMENT"
  echo "ℹ️  Fresh sandbox cluster: deploying $SERVICE before $ACTION"
  if [[ "$ACTION" == "rollback" && -z "$PREBUILT" ]]; then
    local prev_dir; prev_dir="$(mktemp -d)"
    if git -C "$ROOT" cat-file -e "HEAD~1:$CONTEXT" 2>/dev/null; then
      git -C "$ROOT" archive "HEAD~1" "$CONTEXT" | tar -x -C "$prev_dir"
      deploy_version "$(git -C "$ROOT" rev-parse --short HEAD~1)" "$prev_dir/$CONTEXT"
    else
      deploy_version "$TAG-baseline" "$ROOT/$CONTEXT"
    fi
  fi
  deploy_version "$TAG" "$ROOT/$CONTEXT"
}

pod_selector() {
  local s
  s="$(kubectl -n "$NS" get deployment "$DEPLOY" -o go-template='{{range $k,$v := .spec.selector.matchLabels}}{{$k}}={{$v}},{{end}}')"
  echo "${s%,}"
}

show_state() {
  kubectl -n "$NS" get deployment "$DEPLOY" -o wide
  kubectl -n "$NS" get pods -l "$(pod_selector)" -o wide
}

# ---------- actions ----------
case "$ACTION" in
  deploy)
    deploy_version "$TAG" "$ROOT/$CONTEXT"
    show_state
    echo "✅ Deployed $SERVICE ($(current_image)) to $ENVIRONMENT"
    ;;

  scale)
    ensure_deployed
    step "Scaling $DEPLOY to $REPLICAS replicas"
    kubectl -n "$NS" scale "deployment/$DEPLOY" --replicas="$REPLICAS"
    kubectl -n "$NS" rollout status "deployment/$DEPLOY" --timeout="$ROLLOUT_TIMEOUT"
    show_state
    ready="$(kubectl -n "$NS" get deployment "$DEPLOY" -o jsonpath='{.status.readyReplicas}')"
    echo "✅ $SERVICE scaled to ${ready:-0}/$REPLICAS ready replicas in $ENVIRONMENT"
    ;;

  restart)
    ensure_deployed
    step "Restarting $DEPLOY"
    kubectl -n "$NS" rollout restart "deployment/$DEPLOY"
    kubectl -n "$NS" rollout status "deployment/$DEPLOY" --timeout="$ROLLOUT_TIMEOUT"
    show_state
    echo "✅ $SERVICE restarted in $ENVIRONMENT"
    ;;

  rollback)
    ensure_deployed
    before="$(current_image)"
    revisions="$(kubectl -n "$NS" rollout history "deployment/$DEPLOY" | grep -cE '^[0-9]+' || true)"
    (( revisions >= 2 )) || die "No previous revision of $SERVICE in $ENVIRONMENT to roll back to"
    step "Rolling back $DEPLOY (current image: $before)"
    kubectl -n "$NS" rollout undo "deployment/$DEPLOY"
    kubectl -n "$NS" rollout status "deployment/$DEPLOY" --timeout="$ROLLOUT_TIMEOUT"
    kubectl -n "$NS" rollout history "deployment/$DEPLOY"
    echo "✅ Rolled back $SERVICE in $ENVIRONMENT: $before -> $(current_image)"
    ;;

  logs)
    ensure_deployed
    step "Last $TAIL log lines for $SERVICE"
    kubectl -n "$NS" logs -l "$(pod_selector)" --tail="$TAIL" --prefix --all-containers --max-log-requests=10
    ;;

  status)
    if [[ -z "$SERVICE" ]]; then
      kubectl -n "$NS" get deployments,services,pods -o wide
    else
      ensure_deployed
      show_state
      kubectl -n "$NS" rollout history "deployment/$DEPLOY"
      kubectl -n "$NS" rollout status "deployment/$DEPLOY" --timeout=5s && echo "✅ $SERVICE is healthy in $ENVIRONMENT"
    fi
    ;;
esac
