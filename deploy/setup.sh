#!/usr/bin/env bash
# One-shot provisioning for a fresh Ubuntu 22.04/24.04 VM (AWS Lightsail or
# EC2) to run Coral's two long-running processes: the Ping poll loop and
# the free HTTP gateway (src/http/httpGatewayServer.ts). See
# docs/DEPLOYMENT.md for the full walkthrough this script is one step of.
#
# Run as root (or via sudo) on the target VM:
#   curl -fsSL https://raw.githubusercontent.com/Dami904/coral/main/deploy/setup.sh | sudo bash
# or, having reviewed it first (recommended — this repo's own CLAUDE.md
# flags piping an unreviewed remote script into a shell as something not
# to do unexamined; the same standard applies here):
#   sudo bash deploy/setup.sh
set -euo pipefail

REPO_URL="https://github.com/Dami904/coral.git"
APP_DIR="/opt/coral"
DATA_DIR="/var/lib/coral"
CONFIG_DIR="/etc/coral"
SERVICE_USER="coral"
NODE_MAJOR="22"

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root (sudo bash deploy/setup.sh)" >&2
  exit 1
fi

echo "== apt prerequisites =="
apt-get update -y
apt-get install -y curl git ca-certificates python3 python3-pip python3-venv build-essential ufw

echo "== Node ${NODE_MAJOR} (matches this repo's CI pin, .github/workflows/ci.yml) =="
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" != "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi

echo "== pnpm (corepack) =="
corepack enable

echo "== service user + directories =="
# --home-dir points at DATA_DIR (not a separate /home/coral) so pnpm's
# global store and git's config have somewhere writable — nologin still
# blocks interactive ssh/su login, it doesn't block `sudo -u coral <cmd>`.
mkdir -p "$DATA_DIR"
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
mkdir -p "$APP_DIR" "$CONFIG_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR" "$DATA_DIR"
chmod 750 "$CONFIG_DIR"

echo "== sibyl-memory-mcp, in a venv (not --break-system-packages) =="
# A plain `pip3 install --break-system-packages` fights Ubuntu 24.04's
# apt-managed Python packages directly (a Debian-installed typing_extensions
# with no pip RECORD file makes pip's own uninstall-then-reinstall step
# fail outright) — a venv sidesteps that entirely, and is the more robust
# choice for a long-running systemd service anyway (isolated deps, not
# entangled with whatever apt does on a later `apt upgrade`).
VENV_DIR="$DATA_DIR/venv"
if [ ! -d "$VENV_DIR" ]; then
  sudo -u "$SERVICE_USER" python3 -m venv "$VENV_DIR"
fi
sudo -u "$SERVICE_USER" "$VENV_DIR/bin/pip" install --upgrade pip
sudo -u "$SERVICE_USER" "$VENV_DIR/bin/pip" install 'sibyl-memory-cli[mcp]'

echo "== clone/update the repo =="
if [ -d "$APP_DIR/.git" ]; then
  sudo -u "$SERVICE_USER" git -C "$APP_DIR" pull --ff-only
else
  sudo -u "$SERVICE_USER" git clone "$REPO_URL" "$APP_DIR"
fi

echo "== pnpm install + build, matching CI's pinned version =="
PNPM_VERSION=$(node -pe "require('$APP_DIR/package.json').packageManager.split('@')[1]")
corepack prepare "pnpm@${PNPM_VERSION}" --activate
sudo -u "$SERVICE_USER" bash -lc "cd '$APP_DIR' && pnpm install --frozen-lockfile && pnpm build"

echo "== env file =="
if [ ! -f "$CONFIG_DIR/coral.env" ]; then
  cp "$APP_DIR/.env.example" "$CONFIG_DIR/coral.env"
  chown "$SERVICE_USER:$SERVICE_USER" "$CONFIG_DIR/coral.env"
  chmod 600 "$CONFIG_DIR/coral.env"
  echo ">>> Fill in real values in $CONFIG_DIR/coral.env before starting the services."
  echo ">>> Set SIBYL_MEMORY_DB=$DATA_DIR/memory.db in that file — the persistent"
  echo ">>> data directory, not the repo-relative .sibyl-memory-demo/ default."
else
  echo "$CONFIG_DIR/coral.env already exists — leaving it as-is."
fi

echo "== systemd units =="
cp "$APP_DIR/deploy/coral-ping-listener.service" /etc/systemd/system/
cp "$APP_DIR/deploy/coral-http-server.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable coral-ping-listener coral-http-server

echo "== firewall: SSH + the HTTP gateway's port only; the Ping listener needs no inbound port =="
ufw allow OpenSSH
ufw allow 8787/tcp
ufw --force enable

cat <<'EOF'

Setup done. Next steps:
  1. Edit /etc/coral/coral.env with real values (AGENT_PRIVATE_KEY, RPC URL,
     SPEND_GUARD_ADDRESS, VENDOR_PAYTO_ADDRESS, SIBYL_MEMORY_DB pointed at
     /var/lib/coral/memory.db, and SIBYL_MEMORY_MCP_COMMAND set to
     /var/lib/coral/venv/bin/sibyl-memory-mcp — the venv install, not a
     bare command name that assumes it's on PATH) — see docs/DEPLOYMENT.md.
  2. sudo systemctl start coral-http-server
     (and coral-ping-listener once you've deliberately decided to register
     on Ping — see scripts/live-ping-register.ts's own warning; that's a
     real, one-time mainnet spend, not something this script does for you.)
  3. curl http://<this-vm's-IP>:8787/health
  4. journalctl -u coral-http-server -f    # tail logs
EOF
