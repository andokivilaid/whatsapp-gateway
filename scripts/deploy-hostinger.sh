#!/usr/bin/env bash
set -euo pipefail

deploy_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$deploy_root"

compose_files=(-f docker-compose.production.yml -f docker-compose.hostinger.yml)

if ! command -v docker >/dev/null 2>&1; then
  echo 'Docker is required.' >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo 'Docker Compose v2 is required.' >&2
  exit 1
fi
if [[ ! -f .env ]]; then
  echo 'Missing .env — copy .env.production.example and fill secrets.' >&2
  exit 1
fi
if grep -q 'replace-with' .env; then
  echo 'Replace every placeholder in .env before deployment.' >&2
  exit 1
fi

gateway_image="${1:-}"
if [[ -n "$gateway_image" ]]; then
  if grep -q '^GATEWAY_IMAGE=' .env; then
    sed -i.bak "s|^GATEWAY_IMAGE=.*|GATEWAY_IMAGE=${gateway_image}|" .env
  else
    printf 'GATEWAY_IMAGE=%s\n' "$gateway_image" >> .env
  fi
  release="${gateway_image##*:}"
  if grep -q '^GATEWAY_RELEASE=' .env; then
    sed -i.bak "s|^GATEWAY_RELEASE=.*|GATEWAY_RELEASE=${release}|" .env
  else
    printf 'GATEWAY_RELEASE=%s\n' "$release" >> .env
  fi
  rm -f .env.bak
fi

docker compose --env-file .env "${compose_files[@]}" pull
docker compose --env-file .env "${compose_files[@]}" up -d --remove-orphans --wait
docker compose --env-file .env "${compose_files[@]}" exec -T api \
  node -e "fetch('http://127.0.0.1:8080/health/ready').then((r)=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
docker compose --env-file .env "${compose_files[@]}" ps

domain="$(sed -n 's/^DOMAIN=//p' .env | tail -1)"
echo "WhatsApp Gateway is live at https://${domain}"
