/**
 * VPS Configuration
 * Update this with your VPS IP address
 */
export const VPS_CONFIG = {
  /** VPS IP address or hostname */
  ip: 'localhost',
  /** noVNC port (default: 6080) - used for single container mode */
  novncPort: 6080,
  /** Sandbox Manager API port */
  sandboxApiPort: 8090,
  /** VNC password (optional) */
  password: ''
};

/**
 * Get Sandbox Manager API URL
 */
export function getSandboxApiUrl(): string {
  return `http://${VPS_CONFIG.ip}:${VPS_CONFIG.sandboxApiPort}`;
}

/**
 * Get VNC WebSocket URL for a specific port
 */
export function getVncUrl(port: number = VPS_CONFIG.novncPort): string {
  return `ws://${VPS_CONFIG.ip}:${port}`;
}

/**
 * Get VNC HTML page URL for a specific port
 */
export function getVncHtmlUrl(port: number = VPS_CONFIG.novncPort): string {
  return `http://${VPS_CONFIG.ip}:${port}/vnc.html?autoconnect=true&resize=scale`;
}
