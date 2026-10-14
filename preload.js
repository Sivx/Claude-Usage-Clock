const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("clock", {
  onUsage: (cb) => ipcRenderer.on("usage", (_e, u) => cb(u)),
  refresh: () => ipcRenderer.send("refresh"),
  quit: () => ipcRenderer.send("quit"),
});
