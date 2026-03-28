/**
 * IPC Handlers for Tunnel domain
 * Handles: tunnel:* (Cloudflare tunnel setup and lifecycle)
 */

const { ipcMain } = require('electron');

function registerTunnelHandlers({ services }) {
  const { TunnelService } = services;

  /**
   * Get tunnel status (installed, running, currentUrl)
   */
  ipcMain.handle('tunnel:status', () => {
    return TunnelService.getStatus();
  });

  /**
   * Check if cloudflared is installed
   */
  ipcMain.handle('tunnel:isInstalled', () => {
    return TunnelService.isInstalled();
  });

  /**
   * Setup cloudflared (download binary)
   * Downloads ~25MB binary
   */
  ipcMain.handle('tunnel:setup', async (event) => {
    try {
      const status = await TunnelService.setup((progress) => {
        // Send progress updates to renderer
        event.sender.send('tunnel:setup-progress', progress);
      });
      return { success: true, status };
    } catch (err) {
      console.error('Tunnel setup error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Get current tunnel URL
   */
  ipcMain.handle('tunnel:getUrl', () => {
    return TunnelService.getUrl();
  });
}

module.exports = registerTunnelHandlers;
