// drive.js - Google Drive as the family's shared database (JSON files in one shared folder).
// Uses Google Identity Services (token in the browser) + Drive REST v3. No server.
const API = "https://www.googleapis.com/drive/v3";
const UP = "https://www.googleapis.com/upload/drive/v3";
const SCOPE = "https://www.googleapis.com/auth/drive";

let gisLoaded;
function loadGis() {
  if (!gisLoaded) gisLoaded = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client"; s.async = true;
    s.onload = res; s.onerror = () => rej(new Error("Could not load Google sign-in"));
    document.head.appendChild(s);
  });
  return gisLoaded;
}

export class Drive {
  constructor(clientId) {
    this.clientId = clientId;
    try { const t = JSON.parse(localStorage.getItem("gkm.token") || "null"); if (t && t.exp > Date.now() + 60000) this.token = t; } catch { }
  }
  get signedIn() { return !!(this.token && this.token.exp > Date.now() + 30000); }

  async signIn(interactive = true) {
    if (!this.clientId) throw new Error("Google Client ID is not set (Settings)");
    await loadGis();
    return new Promise((resolve, reject) => {
      const tc = google.accounts.oauth2.initTokenClient({
        client_id: this.clientId, scope: SCOPE,
        callback: r => {
          if (r.error) return reject(new Error(r.error_description || r.error));
          this.token = { v: r.access_token, exp: Date.now() + (r.expires_in - 60) * 1000 };
          try { localStorage.setItem("gkm.token", JSON.stringify(this.token)); } catch { }
          resolve(this.token);
        },
        error_callback: e => reject(new Error(e.message || e.type || "sign-in cancelled")),
      });
      tc.requestAccessToken({ prompt: interactive ? "" : "none" });
    });
  }
  signOut() { this.token = null; try { localStorage.removeItem("gkm.token"); } catch { } }

  async req(url, opts = {}, retry = true) {
    if (!this.signedIn) await this.signIn(true);
    const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: "Bearer " + this.token.v } });
    if (r.status === 401 && retry) { this.signOut(); await this.signIn(true); return this.req(url, opts, false); }
    if (!r.ok) throw new Error(`Drive ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r;
  }

  async findFolder(name) {
    const q = encodeURIComponent(`name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const r = await (await this.req(`${API}/files?q=${q}&fields=files(id,name,owners(displayName),shared)&includeItemsFromAllDrives=true&supportsAllDrives=true`)).json();
    return r.files || [];
  }
  async createFolder(name) {
    const r = await this.req(`${API}/files?fields=id,name`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder" }) });
    return r.json();
  }
  async list(folderId) {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
    const r = await (await this.req(`${API}/files?q=${q}&fields=files(id,name,modifiedTime,size)&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true`)).json();
    return r.files || [];
  }
  async meta(id) { return (await this.req(`${API}/files/${id}?fields=id,name,modifiedTime&supportsAllDrives=true`)).json(); }
  async readJson(id) { return (await this.req(`${API}/files/${id}?alt=media&supportsAllDrives=true`)).json(); }

  async writeJson(folderId, name, obj, fileId) {
    const body = JSON.stringify(obj);
    if (fileId) {
      const r = await this.req(`${UP}/files/${fileId}?uploadType=media&fields=id,modifiedTime&supportsAllDrives=true`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body });
      return r.json();
    }
    const boundary = "gkm" + Math.random().toString(36).slice(2);
    const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify({ name, parents: [folderId], mimeType: "application/json" }) +
      `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
    const r = await this.req(`${UP}/files?uploadType=multipart&fields=id,modifiedTime&supportsAllDrives=true`,
      { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body: multipart });
    return r.json();
  }
}
