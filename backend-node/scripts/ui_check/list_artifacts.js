'use strict';
/*
  Lists what this run left on disk outside ui_check: the uploads and outputs the backend
  wrote for the throwaway accounts (from the throwaway DB), and the outbox mail files.
  Read-only. Writes _artifacts/artifacts.json.
*/
const fs = require('fs');
const path = require('path');
const L = require('./lib');

(async () => {
  const S = L.loadState();
  const b = await L.launch();
  const ctx = await L.newContext(b, 'admin', { storageState: S.adminState });
  const q = async (sql) => (await L.api(ctx, 'POST', '/api/admin/db/query', { json: { sql } })).body;
  const ups = await q('SELECT id, user_id, stored_path, original_name, created_at FROM uploads ORDER BY created_at');
  const jobs = await q('SELECT id, user_id, upload_id, state, output_path, output_deleted_at FROM jobs ORDER BY created_at');
  await b.close();
  const abs = (rel) => (rel ? (path.isAbsolute(rel) ? rel : path.join(L.DATA_DIR, rel)) : null);
  const uploads = (ups.rows || []).map((u) => ({ ...u, on_disk: !!abs(u.stored_path) && fs.existsSync(abs(u.stored_path)), has_job: (jobs.rows || []).some((j) => j.upload_id === u.id) }));
  const outputs = [];
  for (const j of jobs.rows || []) {
    const p = abs(j.output_path);
    const variants = p ? ['', '.m4a', '.mp3', '.wav'].map((ext) => (ext ? p.replace(/\.mp4$/, ext) : p)) : [];
    outputs.push({ job: j.id, user_id: j.user_id, state: j.state, output_path: j.output_path, deleted_at: j.output_deleted_at, on_disk: variants.filter((v) => fs.existsSync(v)) });
  }
  const mail = fs.readdirSync(L.MAIL_DIR).filter((f) => f.includes(S.stamp));
  const out = { uploads, outputs, mail };
  fs.writeFileSync(path.join(L.ART, 'artifacts.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
})();
