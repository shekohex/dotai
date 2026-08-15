import type { ProviderEnv } from "@earendil-works/pi-ai";
import { errorMessage } from "../../utils/error-message.js";

const DEFAULT_PROXY_PORTS: Record<string, number> = {
  ftp: 21,
  gopher: 70,
  http: 80,
  https: 443,
  ws: 80,
  wss: 443,
};

function getProxyEnv(key: string, env?: ProviderEnv): string {
  const lowercaseKey = key.toLowerCase();
  const uppercaseKey = key.toUpperCase();
  return (
    env?.[lowercaseKey] ??
    env?.[uppercaseKey] ??
    process.env[lowercaseKey] ??
    process.env[uppercaseKey] ??
    ""
  );
}

function parseProxyTargetUrl(targetUrl: string | URL): URL | undefined {
  if (targetUrl instanceof URL) return targetUrl;
  try {
    return new URL(targetUrl);
  } catch {
    return undefined;
  }
}

function shouldProxyHostname(hostname: string, port: number, env?: ProviderEnv): boolean {
  const noProxy = getProxyEnv("no_proxy", env).toLowerCase();
  if (noProxy.length === 0) return true;
  if (noProxy === "*") return false;

  return noProxy.split(/[,\s]/u).every((proxy) => {
    if (proxy.length === 0) return true;
    const parsedProxy = /^(.+):(\d+)$/u.exec(proxy);
    let proxyHostname = parsedProxy?.[1] ?? proxy;
    const proxyPort = parsedProxy?.[2] === undefined ? 0 : Number.parseInt(parsedProxy[2], 10);
    if (proxyPort !== 0 && proxyPort !== port) return true;
    if (!/^[.*]/u.test(proxyHostname)) return hostname !== proxyHostname;
    if (proxyHostname.startsWith("*")) proxyHostname = proxyHostname.slice(1);
    return !hostname.endsWith(proxyHostname);
  });
}

function getProxyForUrl(targetUrl: string | URL, env?: ProviderEnv): string {
  const parsedUrl = parseProxyTargetUrl(targetUrl);
  if (parsedUrl?.protocol === undefined || parsedUrl.host.length === 0) return "";
  const protocol = parsedUrl.protocol.split(":", 1)[0] ?? "";
  const hostname = parsedUrl.host.replace(/:\d*$/u, "");
  const port = Number.parseInt(parsedUrl.port, 10) || DEFAULT_PROXY_PORTS[protocol] || 0;
  if (!shouldProxyHostname(hostname, port, env)) return "";
  let proxy = getProxyEnv(`${protocol}_proxy`, env) || getProxyEnv("all_proxy", env);
  if (proxy.length > 0 && !proxy.includes("://")) proxy = `${protocol}://${proxy}`;
  return proxy;
}

export function resolveHttpProxyUrlForTarget(
  targetUrl: string | URL,
  env?: ProviderEnv,
): URL | undefined {
  const proxy = getProxyForUrl(targetUrl, env);
  if (proxy.length === 0) return undefined;
  let proxyUrl: URL;
  try {
    proxyUrl = new URL(proxy);
  } catch (error) {
    throw new Error(`Invalid proxy URL ${JSON.stringify(proxy)}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  if (proxyUrl.protocol !== "http:" && proxyUrl.protocol !== "https:") {
    throw new Error(
      `Unsupported proxy protocol ${proxyUrl.protocol}; use an HTTP or HTTPS proxy URL`,
    );
  }
  return proxyUrl;
}
