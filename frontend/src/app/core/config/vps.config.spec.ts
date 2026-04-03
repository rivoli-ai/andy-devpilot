import { getSandboxApiUrl, getVncHtmlUrl, getVncUrl, VPS_CONFIG } from './vps.config';

describe('vps.config', () => {
  it('getSandboxApiUrl matches VPS ip and port', () => {
    expect(getSandboxApiUrl()).toBe(`http://${VPS_CONFIG.ip}:${VPS_CONFIG.sandboxApiPort}`);
  });

  it('getVncUrl uses default novnc port when omitted', () => {
    expect(getVncUrl()).toBe(`ws://${VPS_CONFIG.ip}:${VPS_CONFIG.novncPort}`);
    expect(getVncUrl(1234)).toBe(`ws://${VPS_CONFIG.ip}:1234`);
  });

  it('getVncHtmlUrl builds noVNC page URL', () => {
    const u = getVncHtmlUrl(6081);
    expect(u).toContain(`/vnc.html`);
    expect(u).toContain('autoconnect=true');
    expect(u).toContain('6081');
  });
});
