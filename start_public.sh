#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${ROOT_DIR}/.run"
PID_FILE="${STATE_DIR}/public-dev.pids"
URL_FILE="${STATE_DIR}/public-url.txt"
BACKEND_LOG="${STATE_DIR}/backend.log"
FRONTEND_LOG="${STATE_DIR}/frontend.log"
TUNNEL_LOG="${STATE_DIR}/tunnel.log"

BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-5174}"
BACKEND_URL="http://127.0.0.1:${BACKEND_PORT}"
FRONTEND_URL="http://127.0.0.1:${FRONTEND_PORT}"
MANAGED_BACKEND=0
MANAGED_FRONTEND=0
MANAGED_TUNNEL=0
CLEANUP_DONE=0

mkdir -p "${STATE_DIR}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() {
  printf "${GREEN}[INFO]${NC} %s\n" "$1"
}

log_warn() {
  printf "${YELLOW}[WARN]${NC} %s\n" "$1"
}

log_error() {
  printf "${RED}[ERROR]${NC} %s\n" "$1"
}

is_pid_running() {
  local pid="$1"
  kill -0 "${pid}" 2>/dev/null
}

get_listener_pid() {
  local port="$1"
  lsof -t -iTCP:"${port}" -sTCP:LISTEN 2>/dev/null | head -n 1
}

wait_for_http_200() {
  local url="$1"
  local retries="${2:-30}"
  local delay="${3:-1}"

  for _ in $(seq 1 "${retries}"); do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep "${delay}"
  done
  return 1
}

load_state() {
  BACKEND_PID="${BACKEND_PID:-}"
  FRONTEND_PID="${FRONTEND_PID:-}"
  TUNNEL_PID="${TUNNEL_PID:-}"
  PUBLIC_URL="${PUBLIC_URL:-}"
  MANAGED_BACKEND="${MANAGED_BACKEND:-0}"
  MANAGED_FRONTEND="${MANAGED_FRONTEND:-0}"
  MANAGED_TUNNEL="${MANAGED_TUNNEL:-0}"

  if [[ -f "${PID_FILE}" ]]; then
    # shellcheck disable=SC1090
    source "${PID_FILE}"
  fi
}

save_state() {
  cat >"${PID_FILE}" <<EOF
BACKEND_PID=${BACKEND_PID:-}
FRONTEND_PID=${FRONTEND_PID:-}
TUNNEL_PID=${TUNNEL_PID:-}
PUBLIC_URL=${PUBLIC_URL:-}
MANAGED_BACKEND=${MANAGED_BACKEND:-0}
MANAGED_FRONTEND=${MANAGED_FRONTEND:-0}
MANAGED_TUNNEL=${MANAGED_TUNNEL:-0}
STARTED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
EOF
  if [[ -n "${PUBLIC_URL:-}" ]]; then
    printf "%s\n" "${PUBLIC_URL}" > "${URL_FILE}"
  fi
}

start_backend() {
  local existing_pid
  existing_pid="$(get_listener_pid "${BACKEND_PORT}" || true)"
  if [[ -n "${existing_pid}" ]]; then
    BACKEND_PID="${existing_pid}"
    MANAGED_BACKEND=0
    log_info "后端端口 ${BACKEND_PORT} 已被 PID ${BACKEND_PID} 占用，复用现有进程。"
    return 0
  fi

  if [[ ! -f "${ROOT_DIR}/backend/venv/bin/activate" ]]; then
    log_error "未找到 ${ROOT_DIR}/backend/venv，请先初始化后端虚拟环境。"
    exit 1
  fi

  log_info "启动后端 (${BACKEND_URL}) ..."
  (
    cd "${ROOT_DIR}/backend"
    # shellcheck disable=SC1091
    source venv/bin/activate
    exec python main.py
  ) >"${BACKEND_LOG}" 2>&1 &
  BACKEND_PID=$!
  MANAGED_BACKEND=1

  if ! wait_for_http_200 "${BACKEND_URL}/health" 40 1; then
    log_error "后端启动超时，请查看日志: ${BACKEND_LOG}"
    exit 1
  fi
}

start_frontend() {
  local existing_pid
  existing_pid="$(get_listener_pid "${FRONTEND_PORT}" || true)"
  if [[ -n "${existing_pid}" ]]; then
    FRONTEND_PID="${existing_pid}"
    MANAGED_FRONTEND=0
    log_info "前端端口 ${FRONTEND_PORT} 已被 PID ${FRONTEND_PID} 占用，复用现有进程。"
    return 0
  fi

  if [[ ! -d "${ROOT_DIR}/node_modules" ]]; then
    log_error "未找到 node_modules，请先执行 npm install。"
    exit 1
  fi

  log_info "启动前端 (${FRONTEND_URL}) ..."
  (
    cd "${ROOT_DIR}"
    exec env VITE_API_BASE_URL=/ npm run dev -- --host 127.0.0.1 --port "${FRONTEND_PORT}"
  ) >"${FRONTEND_LOG}" 2>&1 &
  FRONTEND_PID=$!
  MANAGED_FRONTEND=1

  if ! wait_for_http_200 "${FRONTEND_URL}" 40 1; then
    log_error "前端启动超时，请查看日志: ${FRONTEND_LOG}"
    exit 1
  fi

  # Verify proxy to backend is functional.
  if ! wait_for_http_200 "${FRONTEND_URL}/health" 10 1; then
    log_error "前端已启动，但 /health 代理不可用。请查看日志: ${FRONTEND_LOG}"
    exit 1
  fi
}

start_tunnel() {
  local existing_tunnel
  existing_tunnel="$(pgrep -f "ssh .*a.pinggy.io.*-R0:localhost:${FRONTEND_PORT}" | head -n 1 || true)"
  if [[ -n "${existing_tunnel}" ]]; then
    TUNNEL_PID="${existing_tunnel}"
    MANAGED_TUNNEL=0
    if [[ -f "${URL_FILE}" ]]; then
      PUBLIC_URL="$(cat "${URL_FILE}")"
      log_info "检测到已有公网隧道 PID ${TUNNEL_PID}，复用现有链接。"
      return 0
    fi
    log_warn "检测到已有隧道 PID ${TUNNEL_PID}，但没有 URL 记录，尝试重新启动隧道。"
    kill "${TUNNEL_PID}" 2>/dev/null || true
  fi

  : > "${TUNNEL_LOG}"
  log_info "启动公网隧道 (Pinggy, 临时链接约 60 分钟) ..."
  ssh \
    -p 443 \
    -o ExitOnForwardFailure=yes \
    -o StrictHostKeyChecking=no \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    -R0:localhost:"${FRONTEND_PORT}" \
    a.pinggy.io >"${TUNNEL_LOG}" 2>&1 &
  TUNNEL_PID=$!
  MANAGED_TUNNEL=1

  PUBLIC_URL=""
  for _ in $(seq 1 45); do
    if ! is_pid_running "${TUNNEL_PID}"; then
      break
    fi
    PUBLIC_URL="$(grep -Eo 'https://[a-zA-Z0-9.-]+\.free\.pinggy\.link' "${TUNNEL_LOG}" | tail -n 1 || true)"
    if [[ -z "${PUBLIC_URL}" ]]; then
      PUBLIC_URL="$(grep -Eo 'https://[a-zA-Z0-9.-]+' "${TUNNEL_LOG}" | grep -Ev 'dashboard\.pinggy\.io' | tail -n 1 || true)"
    fi
    if [[ -n "${PUBLIC_URL}" ]]; then
      break
    fi
    sleep 1
  done

  if [[ -z "${PUBLIC_URL}" ]]; then
    log_error "未获取到公网地址，请查看日志: ${TUNNEL_LOG}"
    exit 1
  fi
}

cmd_start() {
  echo "===================================="
  echo "  Knowledge IDE Public Dev Startup"
  echo "===================================="

  start_backend
  start_frontend
  start_tunnel
  save_state

  echo ""
  log_info "启动完成。"
  printf "Frontend : %s\n" "${FRONTEND_URL}"
  printf "Backend  : %s\n" "${BACKEND_URL}"
  printf "Public   : %s\n" "${PUBLIC_URL}"
  echo ""
  printf "Logs:\n- %s\n- %s\n- %s\n" "${BACKEND_LOG}" "${FRONTEND_LOG}" "${TUNNEL_LOG}"

  if [[ "${PUBLIC_DEV_DETACH:-0}" == "1" ]]; then
    return 0
  fi

  cleanup_on_exit() {
    if [[ "${CLEANUP_DONE}" == "1" ]]; then
      return
    fi
    CLEANUP_DONE=1
    echo ""
    log_info "收到退出信号，正在停止脚本托管的进程..."
    if [[ "${MANAGED_TUNNEL}" == "1" ]] && [[ -n "${TUNNEL_PID:-}" ]] && is_pid_running "${TUNNEL_PID}"; then
      kill "${TUNNEL_PID}" 2>/dev/null || true
    fi
    if [[ "${MANAGED_FRONTEND}" == "1" ]] && [[ -n "${FRONTEND_PID:-}" ]] && is_pid_running "${FRONTEND_PID}"; then
      kill "${FRONTEND_PID}" 2>/dev/null || true
    fi
    if [[ "${MANAGED_BACKEND}" == "1" ]] && [[ -n "${BACKEND_PID:-}" ]] && is_pid_running "${BACKEND_PID}"; then
      kill "${BACKEND_PID}" 2>/dev/null || true
    fi
    rm -f "${PID_FILE}" "${URL_FILE}"
  }

  trap cleanup_on_exit INT TERM EXIT
  wait
}

cmd_stop() {
  load_state

  if [[ "${MANAGED_TUNNEL:-0}" == "1" ]] && [[ -n "${TUNNEL_PID:-}" ]] && is_pid_running "${TUNNEL_PID}"; then
    kill "${TUNNEL_PID}" 2>/dev/null || true
  fi
  if [[ "${MANAGED_FRONTEND:-0}" == "1" ]] && [[ -n "${FRONTEND_PID:-}" ]] && is_pid_running "${FRONTEND_PID}"; then
    kill "${FRONTEND_PID}" 2>/dev/null || true
  fi
  if [[ "${MANAGED_BACKEND:-0}" == "1" ]] && [[ -n "${BACKEND_PID:-}" ]] && is_pid_running "${BACKEND_PID}"; then
    kill "${BACKEND_PID}" 2>/dev/null || true
  fi

  rm -f "${PID_FILE}" "${URL_FILE}"
  log_info "已停止 public dev 进程（若存在）。"
}

cmd_status() {
  load_state

  echo "===================================="
  echo "  Knowledge IDE Public Dev Status"
  echo "===================================="

  if [[ -n "${BACKEND_PID:-}" ]] && is_pid_running "${BACKEND_PID}"; then
    printf "Backend  : running (pid=%s)\n" "${BACKEND_PID}"
  else
    printf "Backend  : stopped\n"
  fi

  if [[ -n "${FRONTEND_PID:-}" ]] && is_pid_running "${FRONTEND_PID}"; then
    printf "Frontend : running (pid=%s)\n" "${FRONTEND_PID}"
  else
    printf "Frontend : stopped\n"
  fi

  if [[ -n "${TUNNEL_PID:-}" ]] && is_pid_running "${TUNNEL_PID}"; then
    printf "Tunnel   : running (pid=%s)\n" "${TUNNEL_PID}"
  else
    printf "Tunnel   : stopped\n"
  fi

  if [[ -f "${URL_FILE}" ]]; then
    printf "Public   : %s\n" "$(cat "${URL_FILE}")"
  fi
}

cmd_restart() {
  cmd_stop
  sleep 1
  cmd_start
}

usage() {
  cat <<EOF
Usage: $(basename "$0") [start|stop|status|restart]

Default command is start.
EOF
}

ACTION="${1:-start}"
case "${ACTION}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  restart) cmd_restart ;;
  -h|--help|help) usage ;;
  *)
    usage
    exit 1
    ;;
esac
