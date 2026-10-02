// Response models of the pfSense REST API v2 package, limited to the fields this adapter reads.
// Field names follow the package's OpenAPI schema. Every field is optional because older package
// versions omit some, and the adapter must cope with that rather than write placeholder values.

/** GET /api/v2/system/version */
export interface SystemVersion {
    version?: string;
    base?: string;
    patch?: string;
    buildtime?: string;
}

/** GET /api/v2/system/restapi/version */
export interface RestApiVersion {
    current_version?: string;
    latest_version?: string;
    update_available?: boolean;
}

/** GET /api/v2/system/hostname */
export interface SystemHostname {
    hostname?: string;
    domain?: string;
}

/** GET /api/v2/status/system */
export interface SystemStatus {
    platform?: string;
    serial?: string;
    netgate_id?: string;
    uptime?: string;
    bios_vendor?: string;
    bios_version?: string;
    bios_date?: string;
    temp_c?: number | null;
    cpu_model?: string;
    cpu_load_avg?: number[];
    cpu_count?: number;
    cpu_usage?: number;
    mbuf_usage?: number;
    mem_usage?: number;
    swap_usage?: number;
    disk_usage?: number;
}

/** GET /api/v2/status/interfaces (one item) */
export interface InterfaceStats {
    name?: string;
    descr?: string;
    hwif?: string;
    macaddr?: string;
    mtu?: string;
    enable?: boolean;
    status?: string;
    ipaddr?: string;
    subnet?: string;
    ipaddrv6?: string;
    subnetv6?: string;
    inerrs?: number;
    outerrs?: number;
    collisions?: number;
    inbytes?: number;
    outbytes?: number;
    inpkts?: number;
    outpkts?: number;
    media?: string;
    gateway?: string;
}

/** GET /api/v2/status/gateways (one item) */
export interface GatewayStatus {
    name?: string;
    srcip?: string;
    monitorip?: string;
    delay?: number;
    stddev?: number;
    loss?: number;
    status?: string;
    substatus?: string;
}

/** GET /api/v2/status/services (one item) */
export interface Service {
    id?: number;
    name?: string;
    description?: string;
    enabled?: boolean;
    status?: boolean;
}

/** GET /api/v2/status/dhcp_server/leases (one item) */
export interface DhcpLease {
    ip?: string;
    mac?: string;
    hostname?: string;
    if?: string;
    starts?: string;
    ends?: string;
    active_status?: string;
    online_status?: string;
    descr?: string;
}

/** GET /api/v2/diagnostics/arp_table (one item) */
export interface ArpEntry {
    hostname?: string;
    ip_address?: string;
    mac_address?: string;
    interface?: string;
    permanent?: boolean;
    expires?: string;
}

/** GET /api/v2/status/carp */
export interface Carp {
    enable?: boolean;
    maintenance_mode?: boolean;
}

/** GET /api/v2/firewall/virtual_ips (one item) */
export interface VirtualIp {
    id?: number;
    mode?: string;
    interface?: string;
    subnet?: string;
    descr?: string;
    vhid?: number | null;
    carp_status?: string | null;
}

/** A client connected to an OpenVPN server */
export interface OpenVpnServerConnection {
    common_name?: string;
    remote_host?: string;
    virtual_addr?: string;
    bytes_recv?: number;
    bytes_sent?: number;
    connect_time_unix?: number;
    user_name?: string;
}

/** GET /api/v2/status/openvpn/servers (one item) */
export interface OpenVpnServerStatus {
    name?: string;
    mode?: string;
    port?: string;
    vpnid?: number;
    conns?: OpenVpnServerConnection[];
}

/** GET /api/v2/status/openvpn/clients (one item) */
export interface OpenVpnClientStatus {
    name?: string;
    vpnid?: number;
    status?: string;
    state?: string;
    state_detail?: string;
    connect_time?: string;
    virtual_addr?: string;
    remote_host?: string;
}

/** A peer inside a WireGuard tunnel status */
export interface WireGuardPeerStatus {
    public_key?: string;
    endpoint?: string;
    allowed_ips?: string[];
    latest_handshake?: number;
    transfer_rx?: number;
    transfer_tx?: number;
    descr?: string;
}

/** GET /api/v2/status/wireguard/tunnels (one item) */
export interface WireGuardTunnelStatus {
    name?: string;
    status?: string;
    listen_port?: string;
    transfer_rx?: number;
    transfer_tx?: number;
    descr?: string;
    peers?: WireGuardPeerStatus[];
}

/** GET /api/v2/vpn/ipsec/phase1s (one item) */
export interface IpsecPhase1 {
    id?: number;
    ikeid?: number;
    descr?: string;
    disabled?: boolean;
    remote_gateway?: string;
}

/** A child SA inside an IPsec SA status */
export interface IpsecChildSa {
    name?: string;
    state?: string;
    bytes_in?: number;
    bytes_out?: number;
}

/** GET /api/v2/status/ipsec/sas (one item) */
export interface IpsecSa {
    con_id?: string;
    state?: string;
    remote_host?: string;
    local_host?: string;
    established?: number;
    child_sas?: IpsecChildSa[];
}

/** GET /api/v2/firewall/rules (one item) */
export interface FirewallRule {
    id?: number;
    tracker?: number;
    type?: string;
    interface?: string[] | string;
    descr?: string;
    disabled?: boolean;
    floating?: boolean;
}

/** GET /api/v2/firewall/aliases (one item) */
export interface FirewallAlias {
    id?: number;
    name?: string;
    type?: string;
    descr?: string;
    address?: string[];
    detail?: string[];
}

/** GET /api/v2/firewall/apply */
export interface FirewallApply {
    applied?: boolean;
    pending_subsystems?: string[];
}
