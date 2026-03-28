/**
 * IPC handlers for OS8 user account (sign-in via os8.ai)
 */
const { ipcMain } = require('electron');
const AccountService = require('../services/account');

function registerAccountHandlers({ db, mainWindow }) {
  ipcMain.handle('account:get', () => {
    return AccountService.getAccount(db);
  });

  ipcMain.handle('account:sign-in', async () => {
    try {
      const profile = await AccountService.startSignIn(db);
      // Notify renderer of successful sign-in
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('account:signed-in', profile);
      }
      return { success: true, profile };
    } catch (err) {
      console.error('[Account] Sign-in failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('account:sign-out', () => {
    AccountService.signOut(db);
    return { success: true };
  });
}

module.exports = registerAccountHandlers;
