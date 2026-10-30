import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * SSRF guard for merchant-supplied webhook URLs. The API sits on the same
 * network as Postgres and the settlement internal API, and a cloud host
 * exposes credentials at 169.254.169.254, so a webhook must never be sent to
 * a non-public address.
 *
 * Checked when an endpoint is saved (literal IPs and localhost, for a clear
 * 400) and again before every delivery (after DNS resolution, so a hostname
 * that points inward is refused too). Residual risk: DNS rebinding between
 * this lookup and fetch's own; an egress proxy that enforces the same list
 * on the connected address closes that gap.
 */
const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // private (Docker networks)
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b::", 96], // NAT64 (embeds IPv4)
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
  ["2001:db8::", 32], // documentation
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** True only for globally routable unicast addresses. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return isPublicAddress(mapped[1]!);
    return !blocked.check(address, "ipv6");
  }
  return false;
}

function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

/** Save-time check: refuses literal non-public IPs and localhost names. */
export function isObviouslyInternalHost(url: URL): boolean {
  const host = hostOf(url).toLowerCase();
  if (isIP(host)) return !isPublicAddress(host);
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local");
}

export type Resolver = (hostname: string) => Promise<string[]>;

const systemResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

/**
 * Delivery-time check. Resolves the host and returns an error message if
 * it is not allowed (any resolved address non-public, or no address), or
 * null when the delivery may proceed.
 */
export async function checkWebhookDestination(rawUrl: string, resolve: Resolver = systemResolver): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return "blocked_destination: invalid url";
  }
  const host = hostOf(url);
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await resolve(host);
  } catch (err) {
    return `blocked_destination: cannot resolve ${host}: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (addresses.length === 0) return `blocked_destination: ${host} has no address`;
  const internal = addresses.find((address) => !isPublicAddress(address));
  return internal ? `blocked_destination: ${host} resolves to non-public address ${internal}` : null;
}
