const { app, BrowserWindow } = require('electron');
const path = require('path');

// تشغيل خادم الـ Backend المدمج
require('../src/backend/server');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 800,
    minWidth: 960,
    minHeight: 660,
    backgroundColor: '#181818',
    icon: path.join(__dirname, '../src/frontend/assets/icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    },
    title: 'ExecuBot - WhatsApp AI Executive Assistant'
  });

  mainWindow.setMenuBarVisibility(false);

  // الانتظار ثانية حتى يبدأ السيرفر المحلي ثم تحميل الواجهة
  setTimeout(() => {
    mainWindow.loadURL('http://localhost:3001');
  }, 1000);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
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
