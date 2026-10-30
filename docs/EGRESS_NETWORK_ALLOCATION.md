# Egress bridge allocation fallback

Docker's default address pool is finite. Repeating a slot start or recovery does
not free that pool. The egress network ensure path now keeps Docker's normal
allocation first, then handles only the two recognized IPv4 default-pool
exhaustion errors with an explicit-subnet fallback.

## Behavior and limits

- Inventory every current Docker network's IPAM subnets, IPv4 routes from **all**
  host route tables, and IPv4 interface prefixes. Missing tools, malformed output
  or incomplete inventory refuse the fallback; they do not allow a guessed subnet.
- Select a non-overlapping `/24` in `10.203.0.0/16`, with its `.1` gateway. A
  network-name hash spreads initial candidates. The range is a bounded candidate
  reserve, not a guarantee that it is unused on a particular host.
- On Docker's overlap-race error only, refresh the entire inventory and retry,
  up to four explicit create attempts. Other errors return immediately. A fully
  occupied reserve reports a refusal; operators must choose a new allocation
  strategy rather than prune production networks.
- Preserve the existing bridge name, IPv6-disabled and ICC-disabled options.
  Remote-proxy bridges retain masquerade disabled; local-route bridges retain
  masquerade enabled. Existing networks are returned unchanged on later ensures.
- This does not delete networks, change Docker default pools, restart Docker,
  bypass proxy isolation, rebind a slot, clear proxy cooldowns or schedule a new
  background repair loop. Existing manual/automatic start and recovery callers
  gain the fallback when they reach network creation; stopped slots are not
  started merely by installing this code.

The `ip` commands must inspect the **same host network namespace** as the Docker
engine creating the bridge. The supplied host-network control-plane deployment
provides that relationship and installs `iproute2`. A bridged control plane or a
remote Docker daemon needs an appropriate host-side inventory adapter first;
container-only routes are not a valid host inventory. The check is a point-in-time
snapshot, not coordination with future host/VPN route changes.

## Focused fixtures

`test/unit/egress-network.test.mjs` defines deterministic, mocked cases for normal
allocation, unrelated errors, both exhaustion messages, collision avoidance,
invalid inventories, bounded overlap races, local/remote isolation options and
persistent reuse. It never invokes a real Docker daemon or changes host routes.

To run after explicit test authorization:

```sh
node --test test/unit/egress-network.test.mjs
```

Adding fixtures is not a passing-test claim. Live slot diagnosis is not inference
acceptance, and this source change is not active on a server until deployed.
