#!/usr/bin/env bash
# CleanTranslate installer for Debian / Ubuntu (and other apt-based systems).
#
#   sudo ./install.sh                         # native install as a systemd service on port 8080
#   sudo ./install.sh --docker                # run it in Docker instead
#   sudo ./install.sh --domain translate.example.com --admin-auth admin:S3cret
#                                             # + automatic HTTPS with Caddy, admin password
#   sudo ./install.sh --base-path /translate  # serve under https://host/translate/
#   sudo ./install.sh --update                # update in place (keeps your data)
#   sudo ./install.sh --status | --uninstall [--purge]
#
# Run it from a checkout of the repository (git clone … && cd … && sudo ./install.sh).
set -euo pipefail

APP=cleantranslate
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE=""
ACTION=install
PORT=""
BASE_PATH=""
DOMAIN=""
ADMIN_AUTH=""
BASIC_AUTH=""
INSTALL_DIR=/opt/cleantranslate
DATA_DIR=/var/lib/cleantranslate
ENV_FILE=/etc/cleantranslate.env
UNIT=/etc/systemd/system/cleantranslate.service
NODE_MAJOR=24
PURGE=0
SET_BASE=0

c_green=$'\e[32m'; c_yellow=$'\e[33m'; c_red=$'\e[31m'; c_bold=$'\e[1m'; c_off=$'\e[0m'
log()  { echo "${c_green}==>${c_off} $*"; }
warn() { echo "${c_yellow}warning:${c_off} $*" >&2; }
die()  { echo "${c_red}error:${c_off} $*" >&2; exit 1; }

usage() {
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
  cat <<EOF

Options:
  --native              Install as a systemd service using Node.js (default)
  --docker              Install as a Docker container
  --port N              Port to listen on (default 8080)
  --base-path /path     Serve under a sub-path, e.g. /translate
  --domain NAME         Set up Caddy with automatic HTTPS for this domain
  --admin-auth u:p      Password-protect /admin (recommended on the internet)
  --basic-auth u:p      Password-protect the whole app
  --dir PATH            Install directory (native, default $INSTALL_DIR)
  --data PATH           Data directory (native, default $DATA_DIR)
  --update              Update an existing installation, keeping data and settings
  --status              Show service status
  --uninstall           Remove the service (keeps data unless --purge)
  --purge               With --uninstall: also delete data, settings and the user
  -h, --help            This help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --native) MODE=native ;;
    --docker) MODE=docker ;;
    --port) PORT="${2:?}"; shift ;;
    --base-path) BASE_PATH="${2:-}"; SET_BASE=1; shift ;;
    --domain) DOMAIN="${2:?}"; shift ;;
    --admin-auth) ADMIN_AUTH="${2:?}"; shift ;;
    --basic-auth) BASIC_AUTH="${2:?}"; shift ;;
    --dir) INSTALL_DIR="${2:?}"; shift ;;
    --data) DATA_DIR="${2:?}"; shift ;;
    --update) ACTION=update ;;
    --status) ACTION=status ;;
    --uninstall) ACTION=uninstall ;;
    --purge) PURGE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

[[ $EUID -eq 0 ]] || die "please run as root (sudo $0 $*)"
command -v apt-get >/dev/null || die "this installer supports apt-based systems (Debian, Ubuntu, Raspberry Pi OS…)"
[[ -f "$SRC_DIR/server/index.js" ]] || die "run this script from the CleanTranslate repository folder"
if [[ -n "$BASE_PATH" ]]; then
  BASE_PATH="/${BASE_PATH#/}"; BASE_PATH="${BASE_PATH%/}"
  [[ "$BASE_PATH" =~ ^/[A-Za-z0-9._/-]*$ ]] || die "invalid --base-path"
fi

# Detect an existing installation's mode.
detect_mode() {
  if [[ -n "$MODE" ]]; then return; fi
  if [[ -f "$UNIT" ]]; then MODE=native
  elif command -v docker >/dev/null && docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$APP"; then MODE=docker
  else MODE=native; fi
}

env_get() { [[ -f "$ENV_FILE" ]] && grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }
env_set() {
  local key="$1" val="$2"
  touch "$ENV_FILE"
  if grep -qE "^$key=" "$ENV_FILE"; then
    local tmp; tmp="$(mktemp)"
    awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS="="} $1==k{print k"="v; next} {print}' "$ENV_FILE" > "$tmp"
    cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
  else
    echo "$key=$val" >> "$ENV_FILE"
  fi
}

write_env() {
  local first=0
  if [[ ! -f "$ENV_FILE" ]]; then
    first=1
    install -m 0640 /dev/null "$ENV_FILE"
    cat > "$ENV_FILE" <<EOF
# CleanTranslate settings — restart after editing:
#   systemctl restart cleantranslate   (native)   or   sudo ./install.sh --update   (docker)
PORT=8080
HOST=0.0.0.0
BASE_PATH=
DATA_DIR=$DATA_DIR
ADMIN_AUTH=
BASIC_AUTH=
TRUST_PROXY=true
EOF
  fi
  [[ -n "$PORT" ]] && env_set PORT "$PORT"
  [[ $SET_BASE -eq 1 ]] && env_set BASE_PATH "$BASE_PATH"
  [[ -n "$ADMIN_AUTH" ]] && env_set ADMIN_AUTH "$ADMIN_AUTH"
  [[ -n "$BASIC_AUTH" ]] && env_set BASIC_AUTH "$BASIC_AUTH"
  # Behind Caddy on the same host, only listen locally.
  [[ -n "$DOMAIN" ]] && env_set HOST 127.0.0.1
  [[ $first -eq 1 && -z "$DOMAIN" ]] && env_set HOST 0.0.0.0
  if id "$APP" >/dev/null 2>&1; then chown root:"$APP" "$ENV_FILE"; fi
  chmod 0640 "$ENV_FILE"
  PORT="$(env_get PORT)"; PORT="${PORT:-8080}"
  BASE_PATH="$(env_get BASE_PATH)"
}

node_ok() {
  command -v node >/dev/null || return 1
  local v; v="$(node -p 'process.versions.node' 2>/dev/null)" || return 1
  local major="${v%%.*}" rest="${v#*.}"; local minor="${rest%%.*}"
  (( major > 22 || (major == 22 && minor >= 13) ))
}

ensure_node() {
  if node_ok; then log "Node.js $(node -v) found"; return; fi
  log "Installing Node.js $NODE_MAJOR from NodeSource…"
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/nodesource_setup.sh
  bash /tmp/nodesource_setup.sh >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  rm -f /tmp/nodesource_setup.sh
  node_ok || die "Node.js 22.13+ is required but $(node -v 2>/dev/null || echo none) is installed"
  log "Node.js $(node -v) installed"
}

ensure_docker() {
  if command -v docker >/dev/null; then log "Docker found"; return; fi
  log "Installing Docker (get.docker.com)…"
  apt-get update -qq && apt-get install -y -qq ca-certificates curl >/dev/null
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh >/dev/null
  rm -f /tmp/get-docker.sh
  systemctl enable --now docker >/dev/null 2>&1 || true
}

copy_app() {
  log "Copying the app to $INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  rm -rf "$INSTALL_DIR/server" "$INSTALL_DIR/public"
  cp -r "$SRC_DIR/server" "$SRC_DIR/public" "$SRC_DIR/package.json" "$INSTALL_DIR/"
  [[ -f "$SRC_DIR/README.md" ]] && cp "$SRC_DIR/README.md" "$INSTALL_DIR/"
  chown -R root:root "$INSTALL_DIR"
  chmod -R a+rX "$INSTALL_DIR"
}

write_unit() {
  local node_bin; node_bin="$(command -v node)"
  cat > "$UNIT" <<EOF
[Unit]
Description=CleanTranslate — line-aligned translation notes
Documentation=file://$INSTALL_DIR/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP
Group=$APP
EnvironmentFile=$ENV_FILE
Environment=NODE_ENV=production
WorkingDirectory=$INSTALL_DIR
ExecStart=$node_bin $INSTALL_DIR/server/index.js
Restart=on-failure
RestartSec=3
# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ReadWritePaths=$DATA_DIR
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
EOF
}

# GET a URL with whatever is available (curl, wget, or Node itself).
http_ok() {
  if command -v curl >/dev/null; then curl -fsS -o /dev/null "$1" 2>/dev/null
  elif command -v wget >/dev/null; then wget -qO /dev/null "$1" 2>/dev/null
  elif command -v node >/dev/null; then node -e "fetch(process.argv[1]).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" "$1" 2>/dev/null
  else return 1; fi
}

wait_health() {
  local url="http://127.0.0.1:${PORT}/api/health"
  for _ in $(seq 1 40); do
    if http_ok "$url"; then log "Server is up"; return 0; fi
    sleep 0.5
  done
  warn "the server did not answer on $url yet — check: $( [[ $MODE == docker ]] && echo "docker logs $APP" || echo "journalctl -u $APP -n 50" )"
  return 1
}

setup_caddy() {
  [[ -n "$DOMAIN" ]] || return 0
  if ! command -v caddy >/dev/null; then
    log "Installing Caddy (automatic HTTPS)…"
    apt-get update -qq
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg >/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  fi
  local cf=/etc/caddy/Caddyfile block
  if [[ -n "$BASE_PATH" ]]; then
    block="$DOMAIN {
	# CleanTranslate
	redir $BASE_PATH $BASE_PATH/
	handle $BASE_PATH/* {
		reverse_proxy 127.0.0.1:$PORT
	}
}"
  else
    block="$DOMAIN {
	# CleanTranslate
	encode zstd gzip
	reverse_proxy 127.0.0.1:$PORT
}"
  fi
  mkdir -p /etc/caddy
  if [[ ! -f "$cf" ]] || grep -q '/usr/share/caddy' "$cf"; then
    printf '%s\n' "$block" > "$cf"
  elif ! grep -q "^$DOMAIN " "$cf"; then
    printf '\n%s\n' "$block" >> "$cf"
  else
    warn "$cf already has a site block for $DOMAIN — left unchanged"
  fi
  systemctl enable caddy >/dev/null 2>&1 || true
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
  log "Caddy configured for https://$DOMAIN$BASE_PATH/ (make sure DNS points here and ports 80/443 are open)"
}

install_native() {
  ensure_node
  if ! id "$APP" >/dev/null 2>&1; then
    log "Creating system user $APP"
    useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$APP"
  fi
  mkdir -p "$DATA_DIR"
  chown -R "$APP:$APP" "$DATA_DIR"
  chmod 0750 "$DATA_DIR"
  copy_app
  write_env
  write_unit
  systemctl daemon-reload
  systemctl enable "$APP" >/dev/null 2>&1
  systemctl restart "$APP"
  wait_health || true
  setup_caddy
}

install_docker() {
  ensure_docker
  write_env
  log "Building the image…"
  docker build -q -t "$APP:latest" "$SRC_DIR" >/dev/null \
    || die "docker build failed (see above). If Docker Hub answered 429 Too Many Requests, wait a few minutes or run 'docker login' and try again." 
  docker volume create "$APP-data" >/dev/null
  docker rm -f "$APP" >/dev/null 2>&1 || true
  local bind=0.0.0.0
  [[ "$(env_get HOST)" == "127.0.0.1" ]] && bind=127.0.0.1
  log "Starting the container"
  # The container always listens on 8080 internally; PORT is the published host port.
  docker run -d --name "$APP" --restart unless-stopped \
    -p "$bind:$PORT:8080" --env-file "$ENV_FILE" -e PORT=8080 -e HOST=0.0.0.0 -e DATA_DIR=/data \
    -v "$APP-data:/data" "$APP:latest" >/dev/null
  wait_health || true
  setup_caddy
}

summary() {
  local ip; ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  echo
  echo "${c_bold}CleanTranslate is installed.${c_off}"
  if [[ -n "$DOMAIN" ]]; then
    echo "  Editor:  https://$DOMAIN$BASE_PATH/"
    echo "  Admin:   https://$DOMAIN$BASE_PATH/admin"
  else
    echo "  Editor:  http://${ip:-SERVER-IP}:$PORT$BASE_PATH/"
    echo "  Admin:   http://${ip:-SERVER-IP}:$PORT$BASE_PATH/admin"
  fi
  echo "  Settings: $ENV_FILE"
  if [[ $MODE == native ]]; then
    echo "  Data:     $DATA_DIR      Logs: journalctl -u $APP -f"
  else
    echo "  Data:     docker volume $APP-data      Logs: docker logs -f $APP"
  fi
  if [[ -z "$(env_get ADMIN_AUTH)" && -z "$(env_get BASIC_AUTH)" ]]; then
    echo
    warn "no password is set. Before exposing this server publicly, re-run with --admin-auth user:password (or --basic-auth)."
  fi
}

case "$ACTION" in
  install|update)
    detect_mode
    if [[ $ACTION == update ]]; then
      if [[ $MODE == native && ! -f "$UNIT" ]]; then die "no native installation found (use --docker if it runs in Docker)"; fi
      log "Updating ($MODE)…"
    else
      log "Installing CleanTranslate ($MODE)…"
    fi
    if [[ $MODE == docker ]]; then install_docker; else install_native; fi
    summary
    ;;
  status)
    detect_mode
    if [[ $MODE == docker ]]; then docker ps -a --filter "name=^/$APP$" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
    else systemctl --no-pager status "$APP" || true; fi
    PORT="$(env_get PORT)"; PORT="${PORT:-8080}"
    if http_ok "http://127.0.0.1:$PORT/api/health"; then log "health check OK"; else warn "health check failed"; fi
    ;;
  uninstall)
    detect_mode
    if [[ $MODE == docker ]]; then
      docker rm -f "$APP" >/dev/null 2>&1 || true
      [[ $PURGE -eq 1 ]] && docker volume rm "$APP-data" >/dev/null 2>&1 || true
    else
      if [[ -f "$UNIT" ]]; then
        systemctl disable --now "$APP" >/dev/null 2>&1 || true
        rm -f "$UNIT"
        systemctl daemon-reload 2>/dev/null || true
      fi
      rm -rf "$INSTALL_DIR"
      if [[ $PURGE -eq 1 ]]; then rm -rf "$DATA_DIR"; userdel "$APP" 2>/dev/null || true; fi
    fi
    [[ $PURGE -eq 1 ]] && rm -f "$ENV_FILE"
    log "CleanTranslate removed$( [[ $PURGE -eq 1 ]] && echo ' (including data)' || echo " — data kept in $( [[ $MODE == docker ]] && echo "volume $APP-data" || echo "$DATA_DIR" )")"
    ;;
esac
