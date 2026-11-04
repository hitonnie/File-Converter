// Electron entry point: shows the converter (bundled in ./app) in a desktop window, fully offline.
const { app, BrowserWindow, Menu, net, protocol, shell } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

const APP_DIR = path.join(__dirname, 'app');
const START_URL = 'app://local/index.html';

// Serve the app from a custom secure origin rather than file://, so web workers, fetch and
// localStorage behave exactly as they do on the website.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

if (!app.requestSingleInstanceLock()) app.quit();

let mainWindow = null;

const isAppUrl = (url) => url.startsWith('app://') || url.startsWith('blob:app://');

function openExternally(url) {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 400,
    minHeight: 560,
    title: 'File Converter',
    icon: path.join(APP_DIR, 'icon.png'),
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  mainWindow.loadURL(START_URL);

  // "Open" on a converted file shows it in its own window; web links go to the default browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } };
    openExternally(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openExternally(url);
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(() => {
  protocol.handle('app', (request) => {
    const file = path.normalize(path.join(APP_DIR, decodeURIComponent(new URL(request.url).pathname)));
    if (!file.startsWith(APP_DIR + path.sep)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  Menu.setApplicationMenu(null);
  createWindow();
});

app.on('window-all-closed', () => app.quit());
