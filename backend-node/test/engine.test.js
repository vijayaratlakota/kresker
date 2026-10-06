'use strict';
/*
  Tests for the AI-engine wrapper: src/engine.ts (the real client) and src/fakeEngine.ts
  (the GPU-free implementation of the same interface). They run against the compiled
  build:

      npm run build && node --test test/        (or simply: npm test)

  1. VoiceStudioEngine, the HTTP + server-sent-events client, against a local stand-in
     that answers like the GPU engine does - including the ways the real one misbehaves:
     a stream that goes silent, a reply in an unexpected shape, a refusal, no task id.
  2. FakeEngine driven through a whole dub, step by step, the way the worker drives the
     real engine.

  No network beyond 127.0.0.1, no GPU, nothing billed.
*/
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// config.js reads the environment once, when it is first loaded, and creates its data
// directories, so this has to happen before anything from dist/ is required.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kresker-engine-test-'));
process.env.VS_DATA_DIR = DATA;
process.env.VS_STREAM_READ_TIMEOUT_S = '0.5'; // a stalled stream is noticed in half a second
process.env.VS_CONNECT_TIMEOUT_S = '2';
delete process.env.VS_ENGINE_MODE; // the default must be the fake

const engine = require('../dist/engine');
const { FakeEngine } = require('../dist/fakeEngine');

after(() => fs.rmSync(DATA, { recursive: true, force: true }));

// ── a stand-in for the GPU engine ────────────────────────────────────────────

const seg = (i) => ({ id: `c${String(i).padStart(3, '0')}`, start: i * 2.5, end: i * 2.5 + 2.0, text: `line ${i}` });
const sse = (obj) => `data: ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\n`;

function standIn() {
  const seen = { taskStreamQuery: null };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      const json = (status, v) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(v));
      };
      const stream = () => res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const p = url.pathname;

      if (p === '/sysinfo') return json(200, { version: 'stand-in', device: 'cpu' });

      if (p === '/dub/transcribe-stream/good') {
        stream();
        res.write(': a comment line, ignored\n\n');
        res.write(sse({ stage: 'transcribe', detail: 'loading the recogniser', segments: [seg(0), seg(1)] }));
        res.write(sse('this is not JSON and must be skipped'));
        res.write(sse({ stage: 'diarize', segments: [seg(0), seg(1), seg(2)] }));
        res.write(sse({ stage: 'clone', segments: [seg(0)] })); // a SHORTER list must not win
        return res.end();
      }
      if (p === '/dub/transcribe-stream/stall') {
        stream();
        res.write(sse({ stage: 'transcribe', segments: [seg(0), seg(1)] }));
        return; // ...and then silence, as the real engine does when it wedges
      }
      if (p === '/dub/transcribe-stream/silent') {
        stream();
        return; // nothing at all, ever
      }
      if (p === '/dub/transcribe-stream/broken') return json(500, { detail: 'engine fell over' });

      if (p === '/dub/translate') {
        const t = body && body.target_lang;
        if (t === 'te') return json(200, { translated: [{ id: 'c000', text: 'translated' }], target_lang: 'te' });
        if (t === 'list') return json(200, [{ id: 'c000', text: 'a bare list' }]);
        if (t === 'refuse') return json(200, { error: 'unsupported language' });
        if (t === 'odd') return json(200, { surprise: [], other: 1 });
        return json(400, { detail: 'bad request' });
      }

      if (p === '/dub/generate/job-ok') return json(200, { task_id: 'task-1' });
      if (p === '/dub/generate/job-no-task') return json(200, { queued: true });

      if (p === '/tasks/stream/task-1') {
        seen.taskStreamQuery = url.searchParams.get('after_seq');
        stream();
        res.write(sse({ seq: 6, percent: 50.0, type: 'progress' }));
        res.write(sse({ seq: 7, percent: 100.0, type: 'done' }));
        return res.end();
      }
      return json(404, { detail: 'Not Found' });
    });
  });
  return { server, seen };
}

describe('VoiceStudioEngine: the real client, against a stand-in engine', () => {
  const { server, seen } = standIn();
  let client;
  before(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    client = new engine.VoiceStudioEngine(`http://127.0.0.1:${server.address().port}/`);
  });
  after(() => {
    server.closeAllConnections();
    server.close();
  });

  test('readiness: sysinfo answers through the client', async () => {
    assert.equal(client.base.endsWith('/'), false, 'a trailing slash on the base URL is normalised away');
    const info = await client.sysinfo();
    assert.equal(info.version, 'stand-in');
  });

  test('transcribe stream: keeps the richest segment list, collects warnings, reports progress', async () => {
    const progress = [];
    const [segments, warnings] = await client.transcribeStream('good', null, (ev) => progress.push(ev.stage));
    assert.deepEqual(segments.map((s) => s.id), ['c000', 'c001', 'c002']);
    assert.deepEqual(warnings, ['loading the recogniser']);
    assert.deepEqual(progress, ['transcribe', 'diarize', 'clone'], 'every parsed event reaches the caller; junk lines do not');
  });

  test('transcribe stream: a stall keeps what already arrived, and says so', async () => {
    const [segments, warnings] = await client.transcribeStream('stall');
    assert.equal(segments.length, 2);
    assert.match(warnings.at(-1), /stream stalled, kept 2 segments/);
  });

  test('transcribe stream: a stall with nothing received is an error, not an empty success', async () => {
    await assert.rejects(client.transcribeStream('silent'), (e) => e instanceof engine.EngineError && /nothing usable/.test(e.message));
  });

  test('transcribe stream: an HTTP error is an EngineError carrying the status', async () => {
    await assert.rejects(client.transcribeStream('broken'), (e) => e instanceof engine.EngineError && /-> 500/.test(e.message));
  });

  test('translate: the reply is normalised to a list, and the raw reply is kept', async () => {
    const [lines, raw] = await client.translate({ target_lang: 'te', segments: [seg(0)] });
    assert.deepEqual(lines.map((l) => l.text), ['translated']);
    assert.equal(raw.target_lang, 'te');
    const [bare] = await client.translate({ target_lang: 'list' });
    assert.equal(bare[0].text, 'a bare list');
  });

  test('translate: a refusal and an unrecognised shape are both errors, with the reason', async () => {
    await assert.rejects(client.translate({ target_lang: 'refuse' }), /translate refused: unsupported language/);
    await assert.rejects(client.translate({ target_lang: 'odd' }), (e) => e instanceof engine.EngineError && /Keys were: \['other', 'surprise'\]/.test(e.message));
    await assert.rejects(client.translate({ target_lang: 'nope' }), (e) => e instanceof engine.EngineError && /-> 400/.test(e.message));
  });

  test('generate: a task id is required; a reply without one is refused', async () => {
    assert.equal(await client.generate('job-ok', {}), 'task-1');
    await assert.rejects(client.generate('job-no-task', {}), /generate did not return a task id/);
  });

  test('task stream: resumes from a sequence number and yields parsed events', async () => {
    const events = [];
    for await (const ev of client.taskStream('task-1', 5)) events.push(ev);
    assert.equal(seen.taskStreamQuery, '5', 'after_seq reaches the engine');
    assert.deepEqual(events.map((e) => [e.seq, e.type]), [[6, 'progress'], [7, 'done']]);
  });
});

test('an engine that is not running is reported as EngineUnavailable', async () => {
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r)); // nothing listens on that port now
  const client = new engine.VoiceStudioEngine(`http://127.0.0.1:${port}`);
  await assert.rejects(client.sysinfo(), (e) => e instanceof engine.EngineUnavailable && /not reachable/.test(e.message));
});

// ── the fake, through a whole dub ────────────────────────────────────────────

describe('FakeEngine: one whole dub through the Engine interface, no GPU', () => {
  test('the default engine is the fake (VS_ENGINE_MODE unset)', () => {
    assert.ok(engine.getEngine() instanceof FakeEngine);
  });

  test('upload -> prep -> transcribe -> translate -> render -> progress -> download -> clean up', async () => {
    const fake = new FakeEngine();
    const id = engine.newJobId();
    assert.match(id, /^[0-9a-f]{8}$/, 'a fresh 8-hex job id for every upload');

    // Not a real video: the fake measures it with ffprobe and assumes 60 s when it cannot.
    const video = path.join(DATA, 'input.mp4');
    fs.writeFileSync(video, Buffer.alloc(4096, 7));

    assert.ok((await fake.waitReady()).version);
    assert.equal((await fake.upload(video, id)).job_id, id);
    assert.match((await fake.waitPrep(id)).vocals_path, /vocals\.wav$/);

    const progress = [];
    const [streamed, warnings] = await fake.transcribeStream(id, null, (ev) => progress.push(ev));
    assert.ok(streamed.length >= 3);
    assert.ok(progress.length >= 1 && progress.every((ev) => ev.stage === 'transcribe' && Array.isArray(ev.segments)));
    assert.ok(warnings.length >= 1);

    // The stream view and the stored copy carry DIFFERENT ids, exactly as the real engine
    // does. Rendering must use the stored ids; the fake keeps that trap so tests hit it.
    const stored = await fake.storedSegments(id);
    assert.equal(stored.length, streamed.length);
    assert.match(stored[0].id, /^c\d{3}$/);
    assert.match(streamed[0].id, /^s\d{5}$/);

    const [lines, raw] = await fake.translate({ segments: stored, target_lang: 'te', source_lang: 'hi' });
    assert.equal(lines.length, stored.length);
    assert.equal(lines[0].id, stored[0].id);
    assert.match(lines[0].text, /^\[te\] /);
    assert.ok(Array.isArray(raw.translated), 'the raw reply is wrapped under "translated", like the real engine');

    const task = await fake.generate(id, { segments: lines, language_code: 'te' });
    let previous = -1;
    let last = null;
    for await (const ev of fake.taskStream(task)) {
      assert.ok(ev.seq > previous, 'progress events arrive in order');
      previous = ev.seq;
      last = ev;
    }
    assert.equal(last.type, 'done');
    assert.equal(await fake.hasTrack(id, 'te'), true);
    assert.equal(await fake.hasTrack(id, 'ta'), false, 'only the language that was rendered');

    const out = path.join(DATA, 'out', 'dubbed_te.mp4');
    const bytes = await fake.download(id, { default_track: 'te' }, out);
    assert.ok(bytes > 0);
    assert.equal(fs.statSync(out).size, bytes);

    await fake.deleteHistory(id);
    assert.deepEqual(await fake.storedSegments(id), []);
  });
});
