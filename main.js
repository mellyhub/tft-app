const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Open DevTools (optional, remove in production)
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC handler for saving images
ipcMain.handle('save-image', async (event, imageData, filename) => {
  try {
    const imagesDir = path.join(__dirname, 'data', 'images');
    // Create images directory if it doesn't exist
    if (!fs.existsSync(imagesDir)) {
      fs.mkdirSync(imagesDir, { recursive: true });
    }
    const filepath = path.join(imagesDir, filename);
    // Convert base64 to buffer and save
    const buffer = Buffer.from(imageData, 'base64');
    fs.writeFileSync(filepath, buffer);
    return { success: true, filename, path: filepath };
  } catch (error) {
    console.error('Error saving image:', error);
    return { success: false, error: error.message };
  }
});

// IPC handler for deleting images
ipcMain.handle('delete-image', async (event, filename) => {
  try {
    const filepath = path.join(__dirname, 'data', 'images', filename);
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
      return { success: true };
    }
    return { success: false, error: 'File not found' };
  } catch (error) {
    console.error('Error deleting image:', error);
    return { success: false, error: error.message };
  }
});

// Native confirm dialog for destructive actions (delete)
// Returns true if the user confirmed deletion.
ipcMain.handle('confirm-delete', async (event, compName) => {
  try {
    const parent = BrowserWindow.getFocusedWindow ? BrowserWindow.getFocusedWindow() : null;
    const result = await dialog.showMessageBox(parent, {
      type: 'warning',
      buttons: ['Delete', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Confirm deletion',
      message: `Are you sure you want to delete "${compName}"? This action cannot be undone.`,
      detail: 'This will remove the composition from local storage.',
      noLink: true
    });
    return result.response === 0;
  } catch (err) {
    console.error('confirm-delete handler error:', err);
    return false;
  }
});


