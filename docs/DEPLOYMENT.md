# Deployment

How to run Coral continuously, not just for a local demo recording. Not
required for the hackathon submission itself — `PLAN.md`'s demo script is
recorded locally, the same way every `live:*` harness in this repo has
been verified all along. This is for keeping Coral answerable by other
agents *after* Sep 10, or earlier if you want it live sooner.

## Why this can't be a typical PaaS deploy

Sibyl Memory (the SQLite file at `SIBYL_MEMORY_DB`) is the one thing this
whole project is judged on being load-bearing. Any host with an
**ephemeral filesystem** — free-tier Render, Vercel/Lambda functions, a
container platform without a mounted volume — silently resets that file
on every restart/redeploy, which quietly breaks the deletion-test
invariant `CLAUDE.md` requires (deleting memory should be the *only* thing
that resets it, not a routine redeploy). This deploy path assumes a real
VM with a real persistent disk: an AWS Lightsail instance or EC2 instance
with its root/attached volume, or any other Ubuntu 22.04/24.04 box you
control the same way.

## What actually runs

Two independent `systemd` services (`deploy/*.service`), both wrapping
existing `pnpm live:*` scripts — nothing new, no separate deploy-only
code path:

- **`coral-http-server`** — `src/http/httpGatewayServer.ts`, the free HTTP
  entry point (`GET /check`, `/resume`, `/health`). Needs one inbound
  port open (`8787` by default).
- **`coral-ping-listener`** — the Ping poll loop. Outbound-only, no
  inbound port needed. **Do not enable this until you've deliberately
  registered the agent wallet on Ping** (`pnpm live:ping-register`) — that
  registration is real, one-time, irreversible mainnet gas spend, exactly
  the kind of action `CLAUDE.md` says needs an explicit human decision,
  not something a setup script does for you.

Both read secrets from `/etc/coral/coral.env` (never the repo's own
`.env`, and never committed) and write the memory DB to
`/var/lib/coral/memory.db` — a path outside the git-managed `$APP_DIR`
(`/opt/coral`) so a `git pull`/redeploy never touches it.

## AWS setup (Lightsail — simplest; EC2 works identically once the VM exists)

1. **Launch the instance.** Lightsail → Create instance → Linux/Unix →
   OS Only → Ubuntu 24.04 LTS. The cheapest bundle (nano/micro,
   ~$3.50-5/mo, covered by credits) is plenty for this workload — it's two
   lightweight Node processes plus a local Python subprocess, not a
   compute-heavy service. (On plain EC2: a `t3.micro` or `t3.small`,
   Ubuntu 24.04 AMI, works the same way from step 3 on.)
2. **Attach a static IP** (Lightsail: Networking tab → Create static IP,
   free while attached to a running instance) so the address doesn't
   change on a reboot.
3. **Open the firewall** for the HTTP gateway's port, in addition to SSH:
   Lightsail Networking tab (or the EC2 security group) → add a rule for
   TCP `8787` (or whatever you set `HTTP_PORT` to) from `0.0.0.0/0`. Leave
   everything else closed — the Ping listener needs no inbound port at
   all.
4. **SSH in**, then either pipe-and-review or clone-and-run the setup
   script (`deploy/setup.sh` in this repo):
   ```bash
   git clone https://github.com/Dami904/coral.git /tmp/coral-bootstrap
   sudo bash /tmp/coral-bootstrap/deploy/setup.sh
   ```
   This installs Node 22 (matching `.github/workflows/ci.yml`'s pin),
   `sibyl-memory-mcp` (via `pip install`, not the unreviewed `curl | sh`
   one-liner — same standard `CLAUDE.md` already applies to this repo's
   own local setup), creates an unprivileged `coral` system user, clones
   the real repo to `/opt/coral`, runs `pnpm install --frozen-lockfile &&
   pnpm build`, installs the two `systemd` units, and enables `ufw` for
   SSH + the gateway port only.
5. **Fill in `/etc/coral/coral.env`** (copied from `.env.example` by the
   script, mode `600`, owned by the `coral` user). At minimum for the free
   HTTP path on testnet: `AGENT_PRIVATE_KEY`, `BASE_SEPOLIA_RPC_URL`,
   `SPEND_GUARD_ADDRESS`, `VENDOR_PAYTO_ADDRESS`, and —
   **important, override the repo default** —
   `SIBYL_MEMORY_DB=/var/lib/coral/memory.db` (not
   `.sibyl-memory-demo/memory.db`, which would resolve relative to
   `/opt/coral` and get treated as disposable app state, not data).
6. **Start it:**
   ```bash
   sudo systemctl start coral-http-server
   curl http://<static-ip>:8787/health   # {"status":"ok"}
   ```
   Bring up `coral-ping-listener` separately, only after registering on
   Ping deliberately (see the warning above and
   `scripts/live-ping-register.ts`'s own doc comment).
7. **Logs:** `journalctl -u coral-http-server -f` /
   `journalctl -u coral-ping-listener -f`.

## Redeploying after a code change

```bash
sudo bash /opt/coral/deploy/setup.sh   # re-runs safely; git pull, reinstall, rebuild
sudo systemctl restart coral-http-server coral-ping-listener
```
The memory DB lives outside `/opt/coral`, so this never touches it.

## TLS / a real domain

Not set up by `setup.sh` — the gateway serves plain HTTP on `8787` by
default, fine for testing with `curl`/another agent that doesn't need
HTTPS. If you point a domain at the static IP, the lightest addition is a
reverse proxy (Caddy, one line of config, automatic Let's Encrypt) in
front of `127.0.0.1:8787`, with only `443`/`80` open in the firewall
instead of `8787` directly. Not built here — ask if you want it added.

## Cost

Continuous hosting is **not** the "near-zero, only-on-deliberate-runs"
cost model `PLAN.md`'s Cost plan describes for local `live:*` verification
— it's a small but ongoing VM cost (a few dollars a month), covered by AWS
credits here. Real payments this deployment makes (Sibyl `/api/evaluate`
calls, `SpendGuard` gas) are unaffected by *where* it runs — same
Sepolia-by-default, deliberate-mainnet-only behavior as everywhere else in
this repo.
