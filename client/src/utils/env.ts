/**
 * Dynamic Environment & URL Resolution Utility
 *
 * Guarantees environment consistency across development and production:
 * 1. Production Mode: When running on https://web3task-watch-party.vercel.app (or any *.vercel.app / HTTPS domain),
 *    both REST API and Socket.IO strictly route to https://watchparty-backend-kipa.onrender.com.
 *    Never resolves to localhost or laptop LAN IP in production.
 * 2. Local LAN Mode: When running on local Wi-Fi (e.g. http://192.168.1.17:5173 or private IP range),
 *    both REST API and Socket.IO route to http://<laptop-lan-ip>:5000.
 * 3. Localhost Mode: When running on http://localhost:5173 or 127.0.0.1,
 *    both REST API and Socket.IO route to http://localhost:5000.
 */

export const PRODUCTION_FRONTEND_ORIGIN = 'https://web3task-watch-party.vercel.app';
export const PRODUCTION_BACKEND_URL = 'https://watchparty-backend-kipa.onrender.com';
export const LOCAL_DEFAULT_LAN_IP = '192.168.1.17';

export function isPrivateIp(hostname: string): boolean {
  if (!hostname) return false;
  return (
    /^192\.168\.\d+\.\d+$/.test(hostname) ||
    /^10\.\d+\.\d+\.\d+$/.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(hostname) ||
    hostname.endsWith('.local')
  );
}

export function isLocalhost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0';
}

export function isProductionEnvironment(): boolean {
  if (typeof window === 'undefined') return false;
  const { hostname, protocol } = window.location;
  if (hostname.endsWith('vercel.app')) return true;
  if (!isLocalhost(hostname) && !isPrivateIp(hostname) && protocol === 'https:') return true;
  return false;
}

export function resolveBackendUrl(): string {
  if (typeof window === 'undefined') {
    return (import.meta.env.VITE_BACKEND_URL || 'http://localhost:5000').replace(/\/+$/, '');
  }

  const { hostname } = window.location;

  // 1. Production Domain (e.g. web3task-watch-party.vercel.app or any https public host)
  if (isProductionEnvironment()) {
    const envUrl = import.meta.env.VITE_BACKEND_URL;
    if (envUrl && envUrl.startsWith('https://') && !envUrl.includes('localhost')) {
      return envUrl.replace(/\/+$/, '');
    }
    return PRODUCTION_BACKEND_URL;
  }

  // 2. Local Wi-Fi / Private LAN IP (e.g. 192.168.1.17 on mobile phone browser)
  if (isPrivateIp(hostname)) {
    return `http://${hostname}:5000`;
  }

  // 3. Localhost (Laptop browser)
  const envUrl = import.meta.env.VITE_BACKEND_URL;
  if (envUrl && !envUrl.includes('localhost') && envUrl.startsWith('http')) {
    return envUrl.replace(/\/+$/, '');
  }
  return 'http://localhost:5000';
}

export function resolveSocketUrl(): string {
  if (typeof window === 'undefined') {
    return (
      import.meta.env.VITE_SOCKET_URL ||
      import.meta.env.VITE_BACKEND_URL ||
      'http://localhost:5000'
    ).replace(/\/+$/, '');
  }

  const { hostname } = window.location;

  // 1. Production Domain
  if (isProductionEnvironment()) {
    const envUrl = import.meta.env.VITE_SOCKET_URL || import.meta.env.VITE_BACKEND_URL;
    if (envUrl && envUrl.startsWith('https://') && !envUrl.includes('localhost')) {
      return envUrl.replace(/\/+$/, '');
    }
    return PRODUCTION_BACKEND_URL;
  }

  // 2. Local Wi-Fi / Private LAN IP
  if (isPrivateIp(hostname)) {
    return `http://${hostname}:5000`;
  }

  // 3. Localhost
  const envUrl = import.meta.env.VITE_SOCKET_URL || import.meta.env.VITE_BACKEND_URL;
  if (envUrl && !envUrl.includes('localhost') && envUrl.startsWith('http')) {
    return envUrl.replace(/\/+$/, '');
  }
  return 'http://localhost:5000';
}

export type QrTargetPreference = 'auto' | 'lan' | 'production';

export function resolveQrTargetOrigin(preference: QrTargetPreference = 'auto'): string {
  if (typeof window === 'undefined') return PRODUCTION_FRONTEND_ORIGIN;
  const { origin, hostname } = window.location;

  if (preference === 'production') {
    return PRODUCTION_FRONTEND_ORIGIN;
  }

  if (preference === 'lan') {
    return `http://${LOCAL_DEFAULT_LAN_IP}:5173`;
  }

  // Auto mode:
  // If already on production, use the production origin
  if (isProductionEnvironment()) {
    return origin;
  }

  // If already accessed via private LAN IP (e.g. http://192.168.1.17:5173), use that!
  if (isPrivateIp(hostname)) {
    return origin;
  }

  // If accessed via localhost on laptop, phone cannot reach localhost.
  // Use local Wi-Fi LAN IP so phones can scan and connect.
  return `http://${LOCAL_DEFAULT_LAN_IP}:5173`;
}
