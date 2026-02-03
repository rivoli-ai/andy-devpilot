/**
 * VNC connection configuration
 */
export interface VncConfig {
  /** VNC server WebSocket URL (e.g., ws://192.168.1.100:6080) or HTML URL for iframe (e.g., http://192.168.1.100:6080/vnc.html) */
  url: string;
  /** VNC password (optional) */
  password?: string;
  /** Auto-connect on component initialization */
  autoConnect?: boolean;
  /** Scaling mode: 'local' (client-side) or 'remote' (server-side) */
  scalingMode?: 'local' | 'remote';
  /** Default resolution */
  resolution?: string;
  /** Connection timeout in milliseconds */
  timeout?: number;
  /** Use iframe to load noVNC HTML page directly (bypasses bundler issues) */
  useIframe?: boolean;
}

/**
 * VNC connection state
 */
export enum VncConnectionState {
  Disconnected = 'disconnected',
  Connecting = 'connecting',
  Connected = 'connected',
  Disconnecting = 'disconnecting',
  Error = 'error'
}

/**
 * Default VNC configuration
 */
export const DEFAULT_VNC_CONFIG: Partial<VncConfig> = {
  autoConnect: true,
  scalingMode: 'local',
  timeout: 30000
};
