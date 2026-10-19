# Clash / Mihomo subscriptions

The administrator's proxy import area accepts a Clash subscription URL, a YAML file, or pasted YAML. Each supported node gets its **own authenticated SOCKS5 listener** in a dedicated Mihomo sidecar, then enters the existing proxy pool. It is not a single shared `GLOBAL` selector: changing one node never selects a different exit for every slot.

## Optional sidecar (Linux Docker host networking)

Use a build containing this feature. Choose an unused controller port and keep listener ports 20000 onward available. The sidecar must be dedicated to vm2api: imports replace its complete runtime configuration.

1. Generate a random secret of at least 24 characters, for example `openssl rand -hex 32`. Put these settings in the installation's `.env` (never commit it):

   ```dotenv
   VM2API_CLASH_CONTROLLER=http://127.0.0.1:19090
   VM2API_CLASH_SECRET=<your-random-secret>
   ```

2. Create the initial configuration without overwriting any existing subscriptions:

   ```sh
   docker compose -f docker-compose.yml -f docker-compose.clash.yml run --rm --no-deps --entrypoint node vm2api /opt/vm2api/scripts/init-clash.mjs
   docker compose -f docker-compose.yml -f docker-compose.clash.yml up -d
   ```

3. As administrator, open the proxy import area, enter a stable subscription name, and import a link or YAML. The name identifies future updates. Reimport with the **same name** to update. URL imports save the link and enable automatic refresh by default; YAML-only imports remain manual. See [Saved URLs and automatic updates](#saved-urls-and-automatic-updates) for scheduling and safety limits.

The sidecar/controller/listeners default to loopback, matching the existing host-network egress architecture. Do not expose them publicly. Remote cluster nodes do not share the manager's loopback; this configuration is for manager-local egress. Do not use these listeners as remote-node endpoints without a separately secured, reachable network design.

## Update and failure semantics

- Node name within a subscription is its stable identity. Reimports retain pool IDs, ports, credentials and bindings. A renamed node is a new node.
- Missing nodes are disabled, not silently replaced. Their ports remain reserved. If they return, previously enabled nodes recover; manually disabled nodes stay disabled. Existing disabled rows and bindings remain visible for operator handling.
- Rejected YAML or a rejected/unreachable Mihomo controller leaves the previous subscription state in place. A filesystem failure attempts to restore the prior runtime configuration. Runtime reloads may interrupt in-flight connections; this is not a zero-downtime guarantee.
- The JSON state, node credentials and generated Mihomo configuration live in `data/clash`; protect this directory and backups like other service secrets. On manager restart the saved state is reapplied and pool records reconciled. Mihomo restart loads the generated config from the shared directory.

## Supported input and limits

Only inline `proxies` are imported, not subscription rules, DNS, scripts, TUN settings, providers or groups. The generated sidecar configuration enables its own DNS resolver with Cloudflare/Google DNS-over-HTTPS and explicit bootstrap resolvers. This preserves HTTPS (type 65) records required by ECH nodes across imports and restarts; it does not disable ECH or relax certificate verification. Supported protocol types include SS/SSR, VMess/VLESS, Trojan, Hysteria/Hysteria2, TUIC, SOCKS5, HTTP, Snell, WireGuard, SSH, Mieru and AnyTLS, subject to Mihomo's validation. Unsafe external-file, plugin and dialer options are rejected. Unknown types are reported as skipped. A supported type does not guarantee a provider-specific option is accepted by the pinned Mihomo version.

Maximum: 2 MiB input, 500 nodes per import. Base64/URI-only subscriptions and configurations containing only `proxy-providers` are unsupported; request the provider's Clash/Mihomo YAML. URL fetches allow HTTP(S), use bounded downloads, and reject private/local destinations including redirects and DNS results. For a private subscription server, upload its YAML instead.

## Administrator API

- `GET /api/panel/proxies/clash`: configuration-present flag and source metadata only; does not return node passwords or subscription URLs. `configured` is not a health check.
- `POST /api/panel/proxies/clash`: `{ "name": "airport", "url": "https://..." }` or `{ "name": "airport", "yaml": "proxies: ..." }`. Returns added/updated/retired counts and skipped node names. Existing panel authentication applies; tenant users are denied.

Optional environment settings: `VM2API_CLASH_PORT_START` (default 20000), `VM2API_CLASH_LISTEN` and `VM2API_CLASH_PROXY_HOST` (both default 127.0.0.1). Ensure the bind address is reachable from egress before changing these. The controller must stay on local HTTP loopback. To rotate its secret, update the protected config and environment together and restart both services.


## Saved URLs and automatic updates

New URL imports persist the original URL and refresh schedule in `data/clash/subscriptions.json`
(owner-only file permissions on POSIX; protect the data volume and backups). URLs may contain
provider credentials: they are not encrypted at rest and are never returned by the status API.
YAML-only imports are manual; older imports need one same-name URL reimport to save the URL.
A same-name YAML import clears any saved URL and disables automatic updates.

New URL subscriptions refresh every 360 minutes by default. The server checks for due work every
minute and resumes overdue work after restart. A failed update preserves the last good nodes and
configuration, records only a generic error code, and retries after 15 minutes. Downloads retain
the existing size, timeout, redirect and public-address/SSRF protections on every refresh.
No provider URL or raw download/controller error is returned in refresh status.

Identical node configurations do not reload Mihomo. Changed or removed **bound nodes** block the
whole saved-URL refresh, retaining the old configuration; review and explicitly reimport to confirm
such a change. An explicit reimport is not automatically safe for active streams. Other changes
may still reload the complete sidecar configuration and affect existing connections; this feature
is not a zero-disruption hot-reload guarantee and does not automatically change proxy bindings.

The administrator UI offers immediate refresh, pause/resume, interval and timestamps. All API
operations use the existing administrator-only `POST /api/panel/proxies/clash` endpoint:

- Omitted `action` or `action: "import"`: existing import fields, optionally `auto_refresh` (boolean)
  and `refresh_interval_minutes` (integer 15..10080).
- `action: "refresh", source_id`: refresh a saved URL immediately, even while paused. Bound-node
  protection still applies; no URL has to be exposed to the browser.
- `action: "configure", source_id, auto_refresh, refresh_interval_minutes`: persist schedule settings.
- `GET` returns `has_url`, `auto_refresh`, interval, last attempt/success, next refresh and generic
  `last_error` (`refresh_failed` or `bound_nodes_changed`) in addition to source metadata.
