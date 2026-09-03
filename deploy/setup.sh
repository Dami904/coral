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
  # .env.example's placeholder text (e.g. "0x_owner_testnet_key_never_a_real_key")
  # is documentation, not a usable value — but config.ts's zod schema
  # validates a field's regex whenever it's *present*, `.optional()` only
  # skips validation when the key is absent entirely. Left as literal
  # placeholder text, these three make loadConfig() throw and crash-loop
  # the service before it ever binds a port (found running the real
  # deployed service, not by reading the schema). Comment them out here so
  # a fresh deploy starts cleanly on testnet defaults; uncomment and fill
  # in real values only when deliberately going to mainnet.
  sed -i \
    -e 's|^DEPLOYER_PRIVATE_KEY=0x_.*|#&|' \
    -e 's|^MAINNET_SPEND_GUARD_ADDRESS=0x_.*|#&|' \
    -e 's|^MAINNET_VENDOR_PAYTO_ADDRESS=0x_.*|#&|' \
    -e 's|^VENDOR_PRIVATE_KEY=0x_.*|#&|' \
    -e 's|^MOCK_USDC_ADDRESS=0x_.*|#&|' \
    "$CONFIG_DIR/coral.env"
  chown "$SERVICE_USER:$SERVICE_USER" "$CONFIG_DIR/coral.env"
  chmod 600 "$CONFIG_DIR/coral.env"
  echo ">>> Fill in real values in $CONFIG_DIR/coral.env before starting the services"
  echo ">>> (at minimum AGENT_PRIVATE_KEY, SPEND_GUARD_ADDRESS, VENDOR_PAYTO_ADDRESS)."
  echo ">>> Set SIBYL_MEMORY_DB=$DATA_DIR/memory.db and SIBYL_MEMORY_MCP_COMMAND="
  echo ">>> $VENV_DIR/bin/sibyl-memory-mcp in that file — the persistent data"
  echo ">>> directory and the venv install, not the repo-relative/bare-PATH defaults."
else
  echo "$CONFIG_DIR/coral.env already exists — leaving it as-is."
fi

echo "== systemd units =="
cp "$APP_DIR/deploy/coral-ping-listener.service" /etc/systemd/system/
cp "$APP_DIR/deploy/coral-http-server.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable coral-ping-listener coral-http-server

echo "== Caddy: TLS-terminating reverse proxy in front of the HTTP gateway =="
# The gateway itself (src/http/httpGatewayServer.ts) only ever speaks plain
# HTTP on 8787 — no code in this repo does TLS. Left directly exposed,
# that means any browser-based caller on an HTTPS page (GitHub Pages,
# Netlify, coral-landing wherever it ends up hosted — all HTTPS-only by
# default) gets silently mixed-content-blocked by the browser before the
# request ever leaves. Caddy in front, using a nip.io hostname derived
# from this box's own public IP, gets a real Let's Encrypt certificate
# with no domain purchase and no manual DNS step required.
if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -y -qq
  apt-get install -y -qq caddy
fi
PUBLIC_IP="$(curl -fsSL -m 5 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true)"
if [ -n "$PUBLIC_IP" ]; then
  NIP_HOST="$(echo "$PUBLIC_IP" | tr '.' '-').nip.io"
  sed "s/__HOST__/$NIP_HOST/" "$APP_DIR/deploy/Caddyfile.template" > /etc/caddy/Caddyfile
  systemctl enable caddy
  systemctl restart caddy
  echo ">>> HTTPS will be live at https://$NIP_HOST within ~30s of this VM's ports"
  echo ">>> 80/443 being reachable from the internet (cert issuance happens on Caddy's first request)."
else
  echo ">>> Could not auto-detect this VM's public IP (no outbound internet during setup?)."
  echo ">>> Skipping Caddy/TLS — the gateway is still reachable over plain HTTP on 8787."
  echo ">>> See docs/DEPLOYMENT.md to configure deploy/Caddyfile.template by hand later."
fi

echo "== firewall: SSH + Caddy's 80/443 (ACME + HTTPS); 8787 stays local-only, reached via Caddy's reverse proxy =="
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
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
  3. curl https://<this-vm's-public-IP-with-dashes>.nip.io/health
     (or curl http://localhost:8787/health directly on the box — 8787
     itself is not exposed to the internet, only Caddy's 80/443 are.)
  4. journalctl -u coral-http-server -f    # tail logs
     journalctl -u caddy -f                # tail the TLS proxy's logs
EOF
