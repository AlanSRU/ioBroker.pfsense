![Logo](admin/pfsense.png)

# ioBroker.pfsense

[![NPM version](https://img.shields.io/npm/v/iobroker.pfsense.svg)](https://www.npmjs.com/package/iobroker.pfsense)
[![Downloads](https://img.shields.io/npm/dm/iobroker.pfsense.svg)](https://www.npmjs.com/package/iobroker.pfsense)
![Number of Installations](https://iobroker.live/badges/pfsense-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/pfsense-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.pfsense.png?downloads=true)](https://nodei.co/npm/iobroker.pfsense/)

**Tests:** ![Test and Release](https://github.com/AlanSRU/ioBroker.pfsense/workflows/Test%20and%20Release/badge.svg)

## pfSense adapter for ioBroker

Monitors and controls a [pfSense®](https://www.pfsense.org/) firewall (Community Edition or pfSense Plus) through the
community [pfSense REST API package](https://pfrest.org/). One adapter instance talks to one firewall; add an instance per firewall,
including each node of an HA pair.

What it gives you:

- **System**: version, CPU, load, memory, swap, disk and mbuf usage, temperature, uptime, REST API package version and update flag
- **Interfaces**: link state, addresses, MAC, media, byte/packet/error counters and live receive/send rates in bit/s
- **Gateways**: online state, latency, standard deviation, packet loss
- **Services**: running/enabled state of every service, with start, stop and restart buttons
- **Network and presence**: DHCP leases and ARP table merged into a host list; presence devices with debounced
  `present` flag, last-seen time and a Wake-on-LAN button
- **VPN**: OpenVPN servers (connected clients) and clients, WireGuard tunnels and peers (handshake-based connected flag),
  IPsec tunnels (established or down)
- **CARP**: enable and maintenance-mode switches, master/backup state per CARP virtual IP
- **Firewall**: rules with an on/off switch (changes are applied immediately), aliases, pending-changes flag and apply button
- **Control**: optional reboot and shutdown buttons
- **Scripts**: `sendTo` commands for Wake-on-LAN, services, rules, aliases and the host list

pfSense is a registered trademark of Electric Sheep Fencing LLC / Rubicon Communications LLC (Netgate). This adapter is a
community project and is not affiliated with or endorsed by Netgate or the authors of the REST API package.

## Requirements

- pfSense CE 2.8.1 or newer, or pfSense Plus 25.11 or newer
- The [pfSense REST API package](https://pfrest.org/) v2.x installed on the firewall. It is not in the pfSense package
  manager; follow the [installation guide](https://pfrest.org/INSTALL_AND_CONFIG/) of the package. The adapter was developed
  against package v2.10.
- Node.js 22 or newer, js-controller 6.0.11 or newer, admin 7.6.20 or newer

## Setting up the firewall

1. Install the REST API package (see above) and open **System > REST API** on the firewall.
2. Under **Settings**, make sure **Key** authentication is enabled (or **Basic** if you want to use a user name and password),
   and that the interface ioBroker connects through is allowed.
3. Create a dedicated user for ioBroker under **System > User Manager**. For read-only use, the privileges of the `api-v2-…-get`
   endpoints you need are enough (`api-v2-status-system-get` is always required: the adapter uses it to check the connection); for the control features add the matching `…-post`/`…-patch` privileges (or simply
   `page-all` on a test system). Missing privileges do not break the adapter: it logs once which endpoint was refused and
   keeps the rest running.
4. Under **System > REST API > Keys**, create an API key for that user and copy it.

## Setting up the adapter

### Connection

| Setting | Meaning |
|---|---|
| Firewall address | IP address or host name of the pfSense web interface |
| Protocol / Port | Usually HTTPS on 443. Plain HTTP sends the API key unencrypted; avoid it. |
| Certificate check | **Trust only this certificate fingerprint** (default) works with pfSense's self-signed certificate and still detects a different server. **Verify with trusted CAs** needs a certificate from a public or locally trusted CA whose name matches the address. **Do not verify** is insecure and only meant for testing. |
| Certificate fingerprint | SHA-256 fingerprint of the firewall's certificate. **Read certificate fingerprint** fills it in; compare it with **System > Certificates** on the firewall before saving. When the firewall's certificate is renewed, read it again. |
| Authentication | API key (recommended) or user name and password |
| Request timeout | Time limit for a single API call (2–60 s) |

**Test connection** checks the values in the form before you save them.

### Data

The adapter polls in four groups, each with its own interval:

| Group | Default | Range |
|---|---|---|
| Interfaces and gateways | 10 s | 5–3600 s |
| System, services, VPN, CARP | 30 s | 10–3600 s |
| DHCP leases, ARP, presence | 60 s | 15–3600 s |
| Versions, rules, aliases | 300 s | 60–86400 s |

All API calls run one after another, and each group waits for its previous run to finish, so a slow firewall is never flooded.
Each feature can be switched off. Firewall rules and aliases are off by default; with **Only rules whose description contains**
you can limit the rules to the ones you tagged, for example with `[iob]` in their description.

### Network and presence

- **Read DHCP leases and ARP table** fills the `network` channel with counts and a JSON host list. Both pfSense DHCP
  backends (ISC and Kea) are supported.
- **Presence devices**: one row per device you want to track, with a name, the MAC address and optionally the pfSense interface
  (`lan`, `opt1`, …) for Wake-on-LAN. Unticking **Active** pauses a device but keeps its objects (and their history settings);
  deleting the row removes them.
- **Create a device for every host seen** adds a device for every MAC the firewall knows. Names you give these devices in the
  objects view are kept.
- **Keep present after last sighting** avoids false "away" events when a phone sleeps for a moment.
- **Probe presence devices before reporting them away** (on by default): when a device on the presence list is no longer
  seen, the firewall pings its last address once per network poll during the grace period. A device that is still there
  answers (at least the firewall's ARP request, even if it ignores pings) and stays present. A ping to a device that has
  left takes about 11 seconds, so at most three devices are probed per poll. Needs the `api-v2-diagnostics-ping-post`
  privilege and a grace period longer than the network poll interval.

`leaseEnds` assumes pfSense's default of showing lease times in UTC; if "Change DHCP display lease time from UTC to local
time" is ticked in the DHCP server settings, the value is off by the firewall's UTC offset.

A device counts as seen when it has an ARP entry on the firewall or its DHCP lease is reported online. FreeBSD keeps ARP
entries for up to 20 minutes, so a device that leaves can take that long to be reported absent. A device that comes back
is seen as soon as it sends traffic through the firewall (phones and laptops do so immediately; a silent server may not).

### Control

- **Allow starting, stopping and restarting services** creates the service buttons (on by default).
- **Allow reboot and shutdown of the firewall** creates `control.reboot` and `control.halt` (off by default). Anyone who may
  write states in ioBroker can then take your network down.

## Security

- **Certificate pinning.** In the default mode the adapter completes the TLS handshake without CA validation (pfSense's
  certificate is self-signed), then compares the certificate's SHA-256 fingerprint with the one you saved. Only if they match
  exactly is the socket handed to the HTTP layer, so the API key or password is never sent to a server that fails the check.
  "Read certificate fingerprint" opens a connection that only reads the certificate and sends nothing.
- **Credentials** (API key, password) are stored encrypted and are hidden from other adapters. They are never logged.
- **Least privilege.** Give the API user only the privileges for the features you use. Control features (services, rules,
  aliases, CARP, reboot) need write privileges; without them those commands fail and everything else keeps working.

## Objects

| Object | Content |
|---|---|
| `info.connection` | Firewall reachable and API answering. Turns false after two failed calls in a row. |
| `system.*` | `version`, `hostname`, `apiVersion`, `apiUpdateAvailable`, `cpuUsage`, `load1/5/15`, `memoryUsage`, `swapUsage`, `diskUsage`, `mbufUsage`, `temperature` (only if the box has a sensor), `uptime` (s), … |
| `interfaces.<id>.*` | `up`, `status`, `ipv4`, `ipv6`, `mac`, `media`, `rxBytes`, `txBytes`, `rxRate`, `txRate` (bit/s), errors, … |
| `gateways.<name>.*` | `online`, `status`, `latency` (ms), `latencyStdDev`, `packetLoss` (%), `monitorIp` |
| `services.<name>.*` | `running`, `enabled`, `description`, buttons `start`, `stop`, `restart`. Services that run more than once (e.g. two OpenVPN servers) get the description in their id. The REST API cannot start, stop or restart such services (its service model requires unique names), so they have no buttons. |
| `network.*` | `leaseCount`, `arpCount`, `onlineCount`, `hosts` (JSON) |
| `devices.<mac>.*` | `present`, `lastSeen`, `ip`, `hostname`, `mac`, `interface`, `leaseEnds`, button `wake` |
| `vpn.openvpn.servers.server<id>.*` | `clientCount`, `clients` (JSON), `port`, `mode` |
| `vpn.openvpn.clients.client<id>.*` | `connected`, `state`, `virtualAddress`, `remoteHost` |
| `vpn.wireguard.<tunnel>.*` | `up`, `peerCount`, `connectedPeers`, byte counters, and `peers.<key>.connected` / `latestHandshake` / `endpoint` |
| `vpn.ipsec.con<id>.*` | `connected`, `state`, `establishedFor` (s), `remoteGateway` |
| `carp.*` | switches `enabled` and `maintenanceMode`; `vips.<if>_vhid<n>.master` / `status` (only on firewalls with CARP) |
| `firewall.rules.<tracker>.*` | switch `enabled`, `description`, `interface`, `action`. The tracker is pfSense's stable rule id. |
| `firewall.aliases.<name>.*` | `entries` (JSON), `entryCount`, `type` |
| `firewall.pendingChanges`, `firewall.apply` | Unapplied firewall changes, and a button to apply them |
| `control.reboot`, `control.halt` | Only when allowed in the settings |

Values the firewall does not report are left out rather than filled with placeholders. Interfaces, gateways, services, tunnels,
rules and aliases that are removed on the firewall are removed from ioBroker on the next poll.

## Script commands

All commands answer with `{ result }` or `{ error }`.

```js
// Wake a host (the interface is optional when the MAC is in a lease, the ARP table or the presence list)
sendTo('pfsense.0', 'wakeOnLan', { mac: 'aa:bb:cc:dd:ee:ff', interface: 'lan' }, res => log(JSON.stringify(res)));

// Restart a service; `service` is the key used under services.*
sendTo('pfsense.0', 'serviceAction', { service: 'unbound', action: 'restart' }, res => log(JSON.stringify(res)));

// Switch a firewall rule by tracker id and apply
sendTo('pfsense.0', 'setRuleEnabled', { tracker: 1700000123, enabled: false }, res => log(JSON.stringify(res)));

// Add an address to, or remove it from, an alias (and apply)
sendTo('pfsense.0', 'aliasAddEntry', { alias: 'blocked_hosts', entry: '10.0.0.50', detail: 'Tablet' }, res => log(JSON.stringify(res)));
sendTo('pfsense.0', 'aliasRemoveEntry', { alias: 'blocked_hosts', entry: '10.0.0.50' }, res => log(JSON.stringify(res)));

// Apply pending firewall changes
sendTo('pfsense.0', 'applyFirewall', {}, res => log(JSON.stringify(res)));

// Current host list (MAC, IP, host name, interface, online)
sendTo('pfsense.0', 'getHosts', {}, res => log(JSON.stringify(res.result)));
```

The script commands work even when rules and aliases are not shown as objects.

## Known limitations

- **OpenVPN services cannot be started, stopped or restarted** once more than one OpenVPN instance exists. The REST API
  package rejects these requests because several services share the name `openvpn`
  ([pfSense-pkg-RESTAPI#953](https://github.com/pfrest/pfSense-pkg-RESTAPI/issues/953)). The adapter shows their status
  but creates no buttons for them. Tunnel status in `vpn.openvpn.*` is not affected.
- **WireGuard has no connection state.** A peer counts as connected when its last handshake is less than 3 minutes old,
  so a lost peer is reported after up to 3 minutes.
- **Presence relies on what the firewall sees.** Leaving is reported once the firewall's ARP entry has expired (up to
  20 minutes, typically about 12) plus the grace period. A device that returns is seen as soon as it sends traffic.
- **Lease end times** assume pfSense shows DHCP lease times in UTC (the default).
- **One firewall per instance.** For an HA pair, add one instance per node; each reports its own CARP state.
- The adapter only reads what the REST API package offers. Endpoints a firewall does not support (older package,
  missing optional package such as WireGuard, missing privilege) are skipped and logged once.

## Troubleshooting

| Log message | Cause |
|---|---|
| `No REST API answer … Is the pfSense REST API package installed and enabled?` | The package is missing, or the address points to something other than the pfSense web interface. |
| `Authentication failed` | Wrong key or password, or the authentication method is disabled under System > REST API > Settings. |
| `Certificate fingerprint mismatch` | The firewall's certificate changed (renewed or replaced) or another device answers at that address. Read and check the fingerprint again. |
| `TLS check failed` | "Verify with trusted CAs" is selected but the certificate is self-signed or issued for another name. |
| `The API user may not read …` | The API user lacks the privilege for that endpoint. The rest keeps working. |
| `… is not available … package is not installed` | A feature needs a pfSense package that is not installed, for example WireGuard. |

Repeated identical errors are logged once; the adapter keeps retrying with growing pauses (up to 5 minutes) and logs when
the connection is back.

## Changelog
<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**
- (ioBroker-Bot) Adapter requires admin >= 7.8.23 now.

### 0.1.1 (2026-10-02)

- (Alan Paris) Published through CI with npm provenance; Dependabot configuration for dependency updates

### 0.1.0 (2026-10-02)

- (Alan Paris) Initial release: system, interfaces, gateways, services, DHCP/ARP host list and presence, OpenVPN,
  WireGuard, IPsec, CARP, firewall rules and aliases, Wake-on-LAN, optional reboot/shutdown

## License

MIT License

Copyright (c) 2026 Alan Paris <alan.paris@scottish.rugby>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
