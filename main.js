const { app, BrowserWindow, ipcMain, screen } = require("electron");
const { execFile } = require("node:child_process");
const path = require("node:path");

const fs = require("node:fs");

// The usage endpoint rate-limits aggressively, so poll gently. Countdowns tick
// locally in the renderer, so the numbers only need occasional refreshing.
const POLL_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const MIN_MANUAL_GAP_MS = 60_000;

// Claude Code stores its OAuth login in the macOS keychain. Re-read every poll
// so we pick up tokens that Claude Code has refreshed.
function readToken() {
  return new Promise((resolve, reject) => {
    execFile("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], (err, out) => {
      if (err) return reject(new Error("Not logged in to Claude Code"));
      try { resolve(JSON.parse(out).claudeAiOauth.accessToken); }
      catch { reject(new Error("Couldn't parse credentials")); }
    });
  });
}

async function fetchUsage() {
  const token = await readToken();
  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
  });
  if (res.status === 401) throw new Error("Token expired — open Claude Code");
  if (res.status === 429) throw Object.assign(new Error("Rate limited"), { rateLimited: true });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return { session: j.five_hour, weekly: j.seven_day };
}

function createWindow() {
  const { width } = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({
    width: 210, height: 170, x: width - 226, y: 40,
    frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, hasShadow: false, skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile("index.html");

  // Last good result is cached to disk so restarts don't refetch (or blank out).
  const cacheFile = path.join(app.getPath("userData"), "usage-cache.json");
  let state = { data: null, fetchedAt: 0, error: null, nextAt: 0 };
  try { Object.assign(state, JSON.parse(fs.readFileSync(cacheFile, "utf8"))); } catch {}

  let timer = null, backoff = POLL_MS, lastAttempt = 0;
  const send = () => win.webContents.send("usage", state);

  function schedule(delay) {
    // Also refresh just after the session resets, so the ring doesn't sit on stale numbers.
    const reset = state.data?.session?.resets_at && new Date(state.data.session.resets_at).getTime() + 30_000;
    if (reset && reset > Date.now()) delay = Math.min(delay, reset - Date.now());
    clearTimeout(timer);
    state.nextAt = Date.now() + delay;
    timer = setTimeout(poll, delay);
    send();
  }

  async function poll() {
    lastAttempt = Date.now();
    try {
      state.data = await fetchUsage();
      state.fetchedAt = Date.now();
      state.error = null;
      backoff = POLL_MS;
      try { fs.writeFileSync(cacheFile, JSON.stringify({ data: state.data, fetchedAt: state.fetchedAt })); } catch {}
      schedule(POLL_MS);
    } catch (e) {
      state.error = e.message;
      if (e.rateLimited) backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      schedule(e.rateLimited ? backoff : POLL_MS);
    }
  }

  win.webContents.on("did-finish-load", () => {
    const age = Date.now() - state.fetchedAt;
    if (age < POLL_MS) schedule(POLL_MS - age);
    else poll();
  });
  ipcMain.on("refresh", () => {
    if (Date.now() - lastAttempt >= MIN_MANUAL_GAP_MS) poll();
  });
}

if (process.platform === "darwin") app.dock?.hide();
app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
ipcMain.on("quit", () => app.quit());
