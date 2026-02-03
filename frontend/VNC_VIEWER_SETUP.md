# VNC Viewer Component Setup

## Overview
A remote desktop VNC viewer component has been added to the Angular application. When you click "Analyze with AI" on a repository, it will open a full-screen VNC viewer connected to your VPS noVNC server.

## Configuration

### 1. Update VPS IP Address
Edit `frontend/src/app/core/config/vps.config.ts` and update the IP address:

```typescript
export const VPS_CONFIG = {
  ip: 'YOUR_VPS_IP', // e.g., '192.168.1.100' or 'your-vps.example.com'
  novncPort: 6080,
  password: '' // Optional VNC password
};
```

### 2. VPS Setup
Make sure your VPS is running the noVNC server on port 6080. The setup script in `sandbox/vps-setup.sh` configures this automatically.

## Features

- **Full-screen remote desktop** - View and control the remote desktop
- **Auto-connect** - Automatically connects when opened
- **Connection status** - Shows connecting, connected, disconnected, or error states
- **Fullscreen toggle** - Press F11 or click the fullscreen button
- **Screenshot** - Capture screenshots of the remote desktop
- **Auto-hiding controls** - Control panel auto-hides after 3 seconds of inactivity
- **Keyboard shortcuts**:
  - `ESC` - Close viewer (when not in fullscreen)
  - `F11` - Toggle fullscreen

## Usage

1. Navigate to the Repositories page
2. Click "Analyze with AI" on any repository
3. The VNC viewer will open in full-screen mode
4. You'll see the remote desktop with Zed IDE running
5. Click "Close" or press ESC to exit

## Files Created

- `frontend/src/app/components/vnc-viewer/` - VNC viewer component
- `frontend/src/app/core/services/vnc.service.ts` - VNC connection service
- `frontend/src/app/core/services/vnc-viewer.service.ts` - Viewer modal state service
- `frontend/src/app/shared/models/vnc-config.model.ts` - VNC configuration models
- `frontend/src/app/core/config/vps.config.ts` - VPS configuration
- `frontend/src/types/novnc.d.ts` - TypeScript declarations for noVNC

## Dependencies

- `@novnc/novnc@^1.6.0` - noVNC library for VNC connections

## Troubleshooting

### Connection Issues
- Verify the VPS IP is correct in `vps.config.ts`
- Check that port 6080 is open on your VPS firewall
- Ensure the noVNC container is running: `docker ps`
- Check VPS logs: `docker logs devpilot-sandbox`

### TypeScript Errors
- The `@ts-ignore` comment in `vnc.service.ts` handles the missing type definitions
- This is safe as noVNC doesn't provide TypeScript definitions

### Connection Timeout
- Default timeout is 30 seconds
- Increase in `vnc-config.model.ts` if needed

## Next Steps

1. Update `vps.config.ts` with your actual VPS IP
2. Test the connection
3. Optionally, you can re-enable the analysis service in `repositories.component.ts` if you want both VNC viewer and analysis to run
