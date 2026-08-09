// ─── AQUILATE PERSISTENCE (Tauri filesystem backend) ───
// Replaces the old localStorage.setItem/getItem(STORAGE_KEY) calls in
// app.js with a real file on disk, while preserving every user's existing
// browser-version data on first launch.
//
// Load order this file depends on:
//   1. <script src="https://unpkg.com/@tauri-apps/api"...>  (or bundled)
//   2. tauri-plugin-fs / tauri-plugin-dialog JS bindings available on
//      window.__TAURI__.fs / window.__TAURI__.dialog / window.__TAURI__.path
//   3. THIS file
//   4. app.js (which calls the functions exposed on window.AquilatePersistence)
//
// See tauri-setup.md for the Cargo.toml / capabilities / npm install steps
// this depends on.

(function () {
  const { fs, path, dialog } = window.__TAURI__;

  const DATA_FILE   = 'aquilate-data.json';
  const META_FILE   = 'aquilate-meta.json';
  const BACKUP_DIR  = 'backups';
  const MAX_BACKUPS = 10;

  // Same key the browser version has always used — read once, never written
  // to again after migration, so nothing about the old version's behavior
  // changes if someone opens the old web build again.
  const OLD_LS_KEY       = 'aquilate_state';
  const MIGRATION_FLAG   = 'aquilate_migrated_to_file_v1';

  let cachedDataDir = null;

  async function getDataDir() {
    if (cachedDataDir) return cachedDataDir;
    cachedDataDir = await path.appDataDir();
    if (!(await fs.exists(cachedDataDir))) {
      await fs.mkdir(cachedDataDir, { recursive: true });
    }
    return cachedDataDir;
  }

  async function getBackupDir() {
    const dir = await getDataDir();
    const backupDir = await path.join(dir, BACKUP_DIR);
    if (!(await fs.exists(backupDir))) {
      await fs.mkdir(backupDir, { recursive: true });
    }
    return backupDir;
  }

  function looksLikeValidState(p) {
    return !!p && typeof p.month === 'number' && Array.isArray(p.incomes) &&
      Array.isArray(p.categories) && Array.isArray(p.transactions);
  }

  // ── One-time migration: browser localStorage → file ──
  // Runs at most once per install (guarded by a localStorage flag, which is
  // fine to keep using for a flag — it's not user data). Only migrates when
  // the target file doesn't exist yet, so it can never clobber a file a
  // later session already created.
  async function migrateFromLocalStorageIfNeeded() {
    if (localStorage.getItem(MIGRATION_FLAG) === 'true') return { migrated: false };

    const dir = await getDataDir();
    const dataPath = await path.join(dir, DATA_FILE);

    if (await fs.exists(dataPath)) {
      // File already exists (e.g. a previous run created it) — nothing to
      // migrate, just mark done so we stop checking.
      localStorage.setItem(MIGRATION_FLAG, 'true');
      return { migrated: false };
    }

    let raw = null;
    try { raw = localStorage.getItem(OLD_LS_KEY); } catch (e) { /* no localStorage access */ }

    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (looksLikeValidState(parsed)) {
          await fs.writeTextFile(dataPath, raw);
          localStorage.setItem(MIGRATION_FLAG, 'true');
          return { migrated: true };
        }
      } catch (e) {
        console.warn('Found localStorage data but could not parse it during migration:', e);
      }
    }

    // Nothing usable in localStorage (fresh install) — mark done so a brand
    // new user isn't re-checked forever, but leave no file; caller falls
    // back to defaultState().
    localStorage.setItem(MIGRATION_FLAG, 'true');
    return { migrated: false };
  }

  // ── Backups ──
  function timestampForFilename() {
    return new Date().toISOString().replace(/[:.]/g, '-');
  }

  async function rotateBackups() {
    const backupDir = await getBackupDir();
    const entries = await fs.readDir(backupDir);
    const backups = entries
      .filter(e => e.name && e.name.endsWith('.json'))
      .sort((a, b) => (a.name < b.name ? 1 : -1)); // ISO timestamps sort lexically
    const stale = backups.slice(MAX_BACKUPS);
    for (const b of stale) {
      try { await fs.remove(await path.join(backupDir, b.name)); }
      catch (e) { console.warn('Could not prune old backup', b.name, e); }
    }
  }

  async function backupCurrentFileIfExists() {
    const dir = await getDataDir();
    const dataPath = await path.join(dir, DATA_FILE);
    if (!(await fs.exists(dataPath))) return; // first-ever save, nothing to snapshot yet
    const backupDir = await getBackupDir();
    const backupPath = await path.join(backupDir, `aquilate-data-${timestampForFilename()}.json`);
    await fs.copyFile(dataPath, backupPath);
    await rotateBackups();
  }

  async function writeMeta(meta) {
    const dir = await getDataDir();
    const metaPath = await path.join(dir, META_FILE);
    await fs.writeTextFile(metaPath, JSON.stringify(meta));
  }

  async function readMeta() {
    try {
      const dir = await getDataDir();
      const metaPath = await path.join(dir, META_FILE);
      if (!(await fs.exists(metaPath))) return null;
      return JSON.parse(await fs.readTextFile(metaPath));
    } catch (e) { return null; }
  }

  // ── Save ──
  // Backup-then-write, in that order, on every call — never on a timer, so
  // the backup taken is always the state right before the write that could
  // corrupt it. Returns { ok, lastBackedUpAt } mirroring the old
  // saveState()'s true/false contract so app.js's "never claim success on a
  // failed write" logic keeps working unchanged.
  async function saveStateToFile(stateObj) {
    try {
      await backupCurrentFileIfExists();
      const dir = await getDataDir();
      const dataPath = await path.join(dir, DATA_FILE);
      await fs.writeTextFile(dataPath, JSON.stringify(stateObj));
      const lastBackedUpAt = new Date().toISOString();
      await writeMeta({ lastBackedUpAt });
      return { ok: true, lastBackedUpAt };
    } catch (e) {
      console.warn('File save failed:', e);
      return { ok: false, error: String(e) };
    }
  }

  // ── Load ──
  // Three possible outcomes, all distinct on purpose:
  //   { state }            fresh valid data
  //   { state: null }      no file yet (brand new install) — caller uses defaultState()
  //   { corrupted: true }  file exists but won't parse/validate — caller MUST
  //                        show recovery UI, never silently fall back
  async function loadStateFromFile() {
    await migrateFromLocalStorageIfNeeded();
    const dir = await getDataDir();
    const dataPath = await path.join(dir, DATA_FILE);

    if (!(await fs.exists(dataPath))) {
      return { state: null };
    }
    try {
      const raw = await fs.readTextFile(dataPath);
      const parsed = JSON.parse(raw);
      if (!looksLikeValidState(parsed)) {
        return { corrupted: true, reason: 'invalid-shape' };
      }
      return { state: parsed };
    } catch (e) {
      return { corrupted: true, reason: 'parse-error', error: String(e) };
    }
  }

  // ── Recovery ──
  async function listBackups() {
    const backupDir = await getBackupDir();
    const entries = await fs.readDir(backupDir);
    return entries
      .filter(e => e.name && e.name.endsWith('.json'))
      .map(e => e.name)
      .sort((a, b) => (a < b ? 1 : -1)); // newest first
  }

  async function readBackupFile(filename) {
    const backupDir = await getBackupDir();
    const p = await path.join(backupDir, filename);
    const raw = await fs.readTextFile(p);
    return JSON.parse(raw); // let caller catch — a bad backup pick should be visible, not silently skipped
  }

  // Restore = treat a chosen backup as the new primary file (itself
  // preceded by a safety backup of whatever was there, via the normal
  // save path) so restoring is never a one-way door either.
  async function restoreFromBackup(filename) {
    const backupState = await readBackupFile(filename);
    if (!looksLikeValidState(backupState)) {
      throw new Error('Selected backup is not a valid Aquilate state file.');
    }
    return await saveStateToFile(backupState);
  }

  async function getBackupsDirPath() {
    return await getBackupDir();
  }

  async function getLastBackedUpAt() {
    const meta = await readMeta();
    return meta ? meta.lastBackedUpAt || null : null;
  }

  window.AquilatePersistence = {
    loadStateFromFile,
    saveStateToFile,
    listBackups,
    readBackupFile,
    restoreFromBackup,
    getBackupsDirPath,
    getLastBackedUpAt,
    getDataDir,
  };
})();
