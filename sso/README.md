# Craft Suite + Google SSO

Adds Google sign-in in front of the whole suite via
[oauth2-proxy](https://oauth2-proxy.github.io/) + Caddy (TLS). serve.js stays
exactly the same — it just binds to loopback and trusts the user email the
proxy injects.

```
browser ──HTTPS──> Caddy :443 ──> oauth2-proxy :4180 ──> serve.js :8091
                     (TLS)         (Google login,        (loopback only;
                                    X-Forwarded-User)     per-user storage)
```

## Prereqs

- A domain pointing at this machine (Google requires HTTPS redirect URIs —
  bare IPs won't work). Free options: DuckDNS, afraid.org, or a Cloudflare
  Tunnel hostname.
- Port 443 reachable for Caddy's ACME challenge (or use a tunnel / dns-01).

## 1. Google Cloud Console (~10 min)

1. console.cloud.google.com → new project (any name)
2. **APIs & Services → OAuth consent screen** → External → fill app name
   ("Craft Suite"), support email. Scopes: leave default `email profile openid`.
3. **Test users** (while in Testing mode): add the Gmail addresses that should
   be allowed to sign in. Or hit "Publish app" later — basic scopes need no
   verification review.
4. **Credentials → Create → OAuth client ID → Web application**:
   - Authorized redirect URI: `https://YOUR_DOMAIN/oauth2/callback`
   - Copy the client ID + secret into `oauth2-proxy.cfg`

## 2. Binaries

```bash
# oauth2-proxy — single static binary
curl -fsSL https://github.com/oauth2-proxy/oauth2-proxy/releases/latest/download/oauth2-proxy-v7.13.0.linux-amd64.tar.gz | tar xz
sudo install -m755 oauth2-proxy-*/oauth2-proxy /usr/local/bin/

# caddy — distro package or static binary
sudo apt install caddy     # or: caddyserver.com/docs/download
```

## 3. Configure

```bash
mkdir -p ~/.config/craft-sso
cp oauth2-proxy.cfg Caddyfile ~/.config/craft-sso/
# edit both: YOUR_DOMAIN, client id/secret, cookie_secret (openssl rand -base64 32)
```

## 4. Systemd (user services)

```bash
# serve.js: loopback only + trust the proxy's user header
mkdir -p ~/.config/systemd/user/craft-suite.service.d
cp craft-suite-sso.conf ~/.config/systemd/user/craft-suite.service.d/sso.conf

cat > ~/.config/systemd/user/craft-oauth2-proxy.service <<EOF
[Unit]
Description=oauth2-proxy (Craft Suite SSO)
After=network.target
[Service]
ExecStart=/usr/local/bin/oauth2-proxy --config=$HOME/.config/craft-sso/oauth2-proxy.cfg
Restart=on-failure
[Install]
WantedBy=default.target
EOF

cat > ~/.config/systemd/user/craft-caddy.service <<EOF
[Unit]
Description=Caddy TLS for Craft Suite
After=network.target
[Service]
ExecStart=/usr/bin/caddy run --config $HOME/.config/craft-sso/Caddyfile
Restart=on-failure
[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now craft-suite craft-oauth2-proxy craft-caddy
```

Caddy needs port 443 — either run it as a *system* service, or grant the
binary the capability once: `sudo setcap cap_net_bind_service=+ep $(command -v caddy)`.
Alternative: skip Caddy entirely and put a Cloudflare Tunnel in front —
Access can even replace oauth2-proxy.

## 5. Verify

- `https://YOUR_DOMAIN/` → Google sign-in → lands on the suite
- `curl http://localhost:8091/` still works locally (loopback only)
- Files land in `storage/<app>/<user-email>/` per signed-in user
- Direct `http://IP:8091` is unreachable from outside — that's the point
