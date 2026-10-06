'use strict';
/*
  A whole dub through the engine wrapper, the same sequence src/worker.ts runs - minus the
  plan checks, billing and storage around it.

      npm run build
      node examples/dub.js path/to/video.mp4 te

  By default this uses FakeEngine: no GPU, nothing billed, placeholder text, and the
  "dub" is your video with a silent track. With VS_ENGINE_MODE=real and VS_ENGINE_URL
  pointing at a running engine it drives the real one through the same interface (the
  worker then sends the full render preset from src/preset.ts; this example sends only
  what the fake needs).
*/
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (!process.env.VS_DATA_DIR) process.env.VS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kresker-example-'));
const { getEngine, newJobId, EngineError } = require('../dist/engine');

async function main(video, target) {
  if (!video || !fs.existsSync(video)) throw new Error('usage: node examples/dub.js <video file> [target language, default te]');
  const engine = getEngine();
  const id = newJobId();
  console.log(`engine: ${engine.base}   job: ${id}`);

  await engine.waitReady(60, 2, (m) => console.log('  ' + m));
  await engine.upload(video, id);
  await engine.waitPrep(id, 1800, 4, (m) => console.log('  ' + m));

  // Server-sent events: transcription, speaker detection and voice cloning report as they go.
  const [streamed, warnings] = await engine.transcribeStream(id, null, (ev) => {
    if (ev.detail) console.log(`  transcribe: ${ev.detail}`);
  });
  for (const w of warnings) console.log(`  warning: ${w}`);

  // Render from the engine's STORED copy: its ids are the ones it renders by.
  const stored = await engine.storedSegments(id);
  console.log(`transcribed ${streamed.length} lines (stored: ${stored.length})`);

  const [lines] = await engine.translate({ segments: stored, source_lang: 'hi', target_lang: target });
  console.log(`translated ${lines.length} lines, e.g. ${JSON.stringify(String(lines[0].text))}`);

  const task = await engine.generate(id, { segments: lines, language_code: target });
  for await (const ev of engine.taskStream(task)) {
    process.stdout.write(`\r  rendering ${Number(ev.percent)}%   `);
    if (ev.type === 'done') break;
  }
  process.stdout.write('\n');
  if (!(await engine.hasTrack(id, target))) throw new EngineError(`the engine reports no ${target} track`);

  const out = path.join(path.dirname(path.resolve(video)), `${path.parse(video).name}.${target}.mp4`);
  const bytes = await engine.download(id, { default_track: target }, out);
  console.log(`wrote ${out} (${bytes} bytes)`);
  await engine.deleteHistory(id); // clear our media off the (shared) engine
}

main(process.argv[2], process.argv[3] || 'te').catch((e) => {
  console.error(`${e.name}: ${e.message}`);
  process.exit(1);
});
