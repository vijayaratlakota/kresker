'use strict';
/* AREA X2 — "Remove this file" / "Cancel" after an upload: is the video removed from the server? */
const fs = require('fs');
const path = require('path');
const L = require('./lib');

async function run() {
  await L.step('E extras', 'After "Remove this file" / "Cancel", the uploaded video is removed from the server', async () => {
    const a = JSON.parse(fs.readFileSync(path.join(L.ART, 'artifacts.json'), 'utf8'));
    const orphans = a.uploads.filter((u) => !u.has_job && u.on_disk);
    const kept = a.uploads.filter((u) => u.has_job && u.on_disk);
    return {
      status: orphans.length ? 'FAIL' : 'PASS',
      note: `${orphans.length} upload(s) the admin removed/cancelled in the UI are still on disk with no job: ${orphans
        .map((u) => u.stored_path)
        .join(', ')}; the source of a finished dub is also kept (${kept.map((u) => u.stored_path).join(', ')}). Nothing in the Node backend deletes local source uploads except account closure (routers/privacy.ts), while the footer says "Videos are deleted automatically."`,
    };
  });
}

module.exports = { run };
