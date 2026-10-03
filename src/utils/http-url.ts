import { isIP } from 'node:net';

export function buildHttpUrl(bindHost: string, port: number, pathname: string): string {
  const endpointHost = getEndpointHost(bindHost);
  return `http://${formatHostPort(endpointHost, port)}${pathname}`;
}

export function formatHostPort(host: string, port: number): string {
  const displayHost = isIP(host) === 6 ? `[${host}]` : host;
  return `${displayHost}:${port}`;
}

function getEndpointHost(bindHost: string): string {
  if (bindHost === '0.0.0.0') {
    return '127.0.0.1';
  }

  if (bindHost === '::') {
    return '::1';
  }

  return bindHost;
}
