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

Three independent services, two `systemd` units (`deploy/*.service`)
wrapping existing `pnpm live:*` scripts — nothing new, no separate
deploy-only code path — plus Caddy as a TLS-terminating reverse proxy:

- **`coral-http-server`** — `src/http/httpGatewayServer.ts`, the free HTTP
  entry point (`GET /check`, `/resume`, `/health`). Binds `127.0.0.1:8787`
  only (via Caddy in front — see below); not reachable directly from the
  internet.
- **`coral-ping-listener`** — the Ping poll loop. Outbound-only, no
  inbound port needed. **Do not enable this until you've deliberately
  registered the agent wallet on Ping** (`pnpm live:ping-register`) — that
  registration is real, one-time, irreversible mainnet gas spend, exactly
  the kind of action `CLAUDE.md` says needs an explicit human decision,
  not something a setup script does for you.
- **Caddy** — reverse-proxies `443` to `127.0.0.1:8787` and gets a real
  Let's Encrypt certificate automatically, using a hostname derived from
  the VM's own public IP via [nip.io](https://nip.io) (`3-216-178-169.nip.io`
  resolves to `3.216.178.169` — no domain purchase, no manual DNS record).
  This exists because `httpGatewayServer.ts` itself only ever speaks plain
  HTTP: without something terminating TLS in front of it, any browser
  caller on an HTTPS page (GitHub Pages, Netlify, coral-landing wherever
  it's hosted — HTTPS-only by default) gets silently mixed-content-blocked
  before the request ever leaves the browser. The gateway also sends
  `Access-Control-Allow-Origin: *` itself (`src/http/httpGatewayServer.ts`)
  since every route is an unauthenticated GET with no cookie/session to
  leak — so no CORS config is needed in Caddy either.

All three read secrets from `/etc/coral/coral.env` (never the repo's own
`.env`, and never committed) and the app services write the memory DB to
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
3. **Open the firewall** for Caddy's ports, in addition to SSH:
   Lightsail Networking tab (or the EC2 security group) → add rules for
   TCP `80` and `443` from `0.0.0.0/0` (`80` is needed briefly for Let's
   Encrypt's HTTP-01 challenge, `443` for the actual HTTPS traffic). Leave
   `8787` closed to the internet — Caddy is the only public entry point
   for the gateway — and leave everything else closed too; the Ping
   listener needs no inbound port at all.
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
   pnpm build`, installs the two `systemd` units, installs and configures
   Caddy (deriving a nip.io hostname from the VM's own public IP), and
   enables `ufw` for SSH + `80`/`443` only.
5. **Fill in `/etc/coral/coral.env`** (copied from `.env.example` by the
   script, mode `600`, owned by the `coral` user). At minimum for the free
   HTTP path on testnet: `AGENT_PRIVATE_KEY`, `BASE_SEPOLIA_RPC_URL`,
   `SPEND_GUARD_ADDRESS`, `VENDOR_PAYTO_ADDRESS`, and — **important,
   override both repo defaults** —
   `SIBYL_MEMORY_DB=/var/lib/coral/memory.db` (not
   `.sibyl-memory-demo/memory.db`, which would resolve relative to
   `/opt/coral` and get treated as disposable app state, not data) and
   `SIBYL_MEMORY_MCP_COMMAND=/var/lib/coral/venv/bin/sibyl-memory-mcp`
   (the script installs it into a venv, not system-wide, so the bare
   `sibyl-memory-mcp` default won't be on `PATH`).
6. **Start it:**
   ```bash
   sudo systemctl start coral-http-server
   curl https://<public-ip-with-dashes>.nip.io/health   # {"status":"ok"}
   ```
   (e.g. `3.216.178.169` → `https://3-216-178-169.nip.io/health`.) Give
   Caddy a few seconds on first start to obtain its certificate — see the
   `## TLS` section below if this doesn't resolve.
   Bring up `coral-ping-listener` separately, only after registering on
   Ping deliberately (see the warning above and
   `scripts/live-ping-register.ts`'s own doc comment).
7. **Logs:** `journalctl -u coral-http-server -f` /
   `journalctl -u coral-ping-listener -f` / `journalctl -u caddy -f`.

## Redeploying after a code change

```bash
sudo bash /opt/coral/deploy/setup.sh   # re-runs safely; git pull, reinstall, rebuild
sudo systemctl restart coral-http-server coral-ping-listener
```
The memory DB lives outside `/opt/coral`, so this never touches the file
itself — but **one specific redeploy (2026-09-04, the job-cache
generalization) changes what's *inside* it**: the Sibyl Memory category
the job cache writes under changed from the old fixed `"token_verdict"`
to `hiredAgentId` (`sibyl-conviction-check` for this deployment, per
`scripts/lib/liveHarness.ts`). Existing cached entries under the old
category become unreachable — the next `/check` for a contract that was
already cached pays again, same effect as deleting memory (an
already-tested, understood event here), not data loss or a bug. One-time,
already applied to this deployment; not a recurring concern for future
redeploys.

**If the VM's public IP changes** (a new Elastic IP, a replaced instance),
`setup.sh` re-derives the nip.io hostname and rewrites `/etc/caddy/Caddyfile`
automatically on its next run — but `coral-landing/index.html`'s `GATEWAY`
constant (in its `<script>` block near the bottom of the file) is a
**separate, hardcoded copy** of that same hostname and does not update
itself. Update it by hand and redeploy the landing page too, or the live
widget will silently point at a dead host.

**Low-memory VMs** (a `t3.micro`'s ~900MB RAM): a bare `tsc` build can get
OOM-killed with no swap configured. If `pnpm build` dies with exit 137,
add a swapfile first:
```bash
sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## TLS

`setup.sh` installs and configures this automatically (see "What actually
runs" above) — Caddy in front of the gateway, a Let's Encrypt certificate
for a nip.io hostname derived from the VM's own public IP, no domain
purchase or manual DNS step needed. Two things worth knowing if it doesn't
just work:
- Certificate issuance needs ports `80` and `443` reachable from the
  internet (Let's Encrypt's HTTP-01 challenge uses `80`) — check both the
  cloud firewall (security group) and `ufw` on the box itself; either one
  left closed produces the same "Timeout during connect (likely firewall
  problem)" error in `journalctl -u caddy`.
- If you'd rather use a real domain you own instead of a nip.io one, point
  an `A` record at the VM's IP and edit `/etc/caddy/Caddyfile`'s hostname
  directly, then `sudo systemctl reload caddy`.

## Cost

Continuous hosting is **not** the "near-zero, only-on-deliberate-runs"
cost model `PLAN.md`'s Cost plan describes for local `live:*` verification
— it's a small but ongoing VM cost (a few dollars a month), covered by AWS
credits here. Real payments this deployment makes (Sibyl `/api/evaluate`
calls, `SpendGuard` gas) are unaffected by *where* it runs — same
Sepolia-by-default, deliberate-mainnet-only behavior as everywhere else in
this repo.
