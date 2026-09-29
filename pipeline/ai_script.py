"""
AI script refinement (Stage 4/5) — the "review and redub" step, done by an LLM.

Two problems this solves, both observed in real output:

1. ASR nonsense reaching the dub verbatim. Whisper produced "I am a saloni" and
   "I have not pregnant for a while"; the TTS faithfully spoke that garbage.
   Gemini repairs such lines using surrounding context.

2. Translations far too long for their time slot. A line needing 2-3x audio
   compression to fit is what made the dub sound sped-up and robotic, and what
   cascaded the timeline. Compressing harder cannot fix this — the TEXT has to
   be shorter. So we give the model a per-line character budget derived from the
   slot duration and require the translation to fit inside it.

Efficiency: every line for the whole video goes in ONE request (chunked only for
very long videos), so this costs a couple of calls per job rather than one per
segment — important because per-minute quotas are the binding constraint.

Falls back silently to the existing translator if anything fails.
"""

import json
import os

MODEL = os.environ.get("AI_SCRIPT_MODEL", "gemini-2.5-flash")
CHUNK = int(os.environ.get("AI_SCRIPT_CHUNK", "40"))

# Comfortable speaking speed (characters per second) at natural pace, per
# target language. Budgets derive from these, so a line that fits the budget
# needs little or no time-stretching. Measured from Chirp3-HD/Gemini-TTS output
# (Telugu ~9.5-10.5 chars/s for natural delivery).
CHARS_PER_SEC = {
    "te": 10.5, "hi": 11.5, "ta": 10.0, "kn": 10.0, "ml": 10.0,
    "bn": 11.0, "gu": 11.5, "mr": 11.0, "pa": 11.5, "ur": 11.5,
    "en": 14.0, "es": 14.0, "fr": 14.0, "de": 13.0, "it": 14.0,
    "pt": 14.0, "ru": 12.0, "ja": 8.0, "ko": 9.0, "zh-cn": 6.0,
    "ar": 12.0, "tr": 12.0, "nl": 13.0, "pl": 12.0,
}

LANG_NAME = {
    "te": "Telugu", "hi": "Hindi", "ta": "Tamil", "kn": "Kannada",
    "ml": "Malayalam", "bn": "Bengali", "gu": "Gujarati", "mr": "Marathi",
    "pa": "Punjabi", "ur": "Urdu", "en": "English", "es": "Spanish",
    "fr": "French", "de": "German", "it": "Italian", "pt": "Portuguese",
    "ru": "Russian", "ja": "Japanese", "ko": "Korean", "zh-cn": "Chinese",
    "ar": "Arabic", "tr": "Turkish", "nl": "Dutch", "pl": "Polish",
}


def budget_for(seconds, target_lang, headroom=1.10):
    """Character budget a voice actor can comfortably say in `seconds`."""
    cps = CHARS_PER_SEC.get(target_lang, 11.0)
    return max(6, int(seconds * cps * headroom))


def _headers_and_url():
    import google.auth
    from google.auth.transport.requests import Request

    creds, proj = google.auth.default(
        scopes=["https://www.googleapis.com/auth/cloud-platform"])
    creds.refresh(Request())
    project = (os.environ.get("CHIRP_PROJECT")
               or os.environ.get("GOOGLE_CLOUD_PROJECT") or proj)
    if not project:
        raise RuntimeError("No GCP project for AI script refinement")
    headers = {
        "Authorization": f"Bearer {creds.token}",
        "x-goog-user-project": project,
        "Content-Type": "application/json; charset=utf-8",
    }
    url = (f"https://aiplatform.googleapis.com/v1/projects/{project}"
           f"/locations/global/publishers/google/models/{MODEL}:generateContent")
    return headers, url


def _call(prompt, timeout=240):
    import requests
    headers, url = _headers_and_url()
    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.3,
                             "responseMimeType": "application/json"},
    }
    r = requests.post(url, headers=headers, json=body, timeout=timeout)
    if r.status_code != 200:
        raise RuntimeError(f"AI script {r.status_code}: {r.text[:200]}")
    txt = r.json()["candidates"][0]["content"]["parts"][0]["text"]
    return json.loads(txt)


def _prompt(items, src_name, dst_name):
    return f"""You are a professional dubbing script writer for {src_name} to {dst_name} dubbing.

For each line you get: index (i), slot duration in seconds (sec), a character budget (budget), and raw ASR text (src) that may contain speech-recognition errors.

Do TWO things per line:
1. "fixed": repair obvious ASR errors so the line is natural and meaningful in {src_name}, using the surrounding lines as context. Preserve the speaker's intent and tone. Do not invent new content. If the line is already fine, keep it.
2. "dst": translate the fixed line into natural, spoken {dst_name} that a voice actor can comfortably say WITHIN the slot. The translation MUST be at most `budget` characters. Use short, colloquial, conversational phrasing. Drop filler rather than exceed the budget. Never pad to reach the budget. Keep exclamations and names as they are.

Return ONLY valid JSON in exactly this form:
{{"lines":[{{"i":0,"fixed":"...","dst":"..."}}]}}

Lines:
{json.dumps(items, ensure_ascii=False)}"""


def _shrink_prompt(items, dst_name):
    return f"""These {dst_name} dubbing lines are TOO LONG for their time slots.

Rewrite each to convey the same meaning in at most `budget` characters. Use shorter words and colloquial spoken {dst_name}. Keep names and exclamations. Do not add anything.

Return ONLY valid JSON: {{"lines":[{{"i":0,"dst":"..."}}]}}

Lines:
{json.dumps(items, ensure_ascii=False)}"""


def refine_script(segments, source_lang, target_lang, emit=None):
    """Repair ASR text and produce length-budgeted translations.

    Mutates each segment: sets seg["text"] (repaired) and seg["translated"].
    Returns a per-line report list. Raises on hard failure so the caller can
    fall back to the plain translator.
    """
    src_name = LANG_NAME.get((source_lang or "").lower(), "the source language")
    dst_name = LANG_NAME.get((target_lang or "").lower(), target_lang)

    items = []
    for i, seg in enumerate(segments):
        sec = max(0.2, float(seg["end"]) - float(seg["start"]))
        items.append({"i": i, "sec": round(sec, 2),
                      "budget": budget_for(sec, target_lang),
                      "src": (seg.get("text") or "").strip()})

    results = {}
    for start in range(0, len(items), CHUNK):
        part = items[start:start + CHUNK]
        if emit:
            emit("translate", 50,
                 f"AI script pass {start // CHUNK + 1} "
                 f"({len(part)} lines)")
        data = _call(_prompt(part, src_name, dst_name))
        for L in data.get("lines", []):
            try:
                results[int(L["i"])] = (L.get("fixed", ""), L.get("dst", ""))
            except Exception:
                continue

    if not results:
        raise RuntimeError("AI script returned nothing")

    # Second pass: shrink any line that still exceeds its budget.
    over = []
    for it in items:
        got = results.get(it["i"], ("", ""))[1]
        if got and len(got) > it["budget"]:
            over.append({"i": it["i"], "budget": it["budget"], "dst": got})
    if over:
        if emit:
            emit("translate", 52, f"Tightening {len(over)} long line(s)")
        try:
            data = _call(_shrink_prompt(over, dst_name))
            for L in data.get("lines", []):
                i = int(L["i"])
                new = L.get("dst", "")
                if new and i in results:
                    results[i] = (results[i][0], new)
        except Exception:
            pass  # keep the longer version; stretching will absorb it

    report = []
    for it in items:
        i = it["i"]
        fixed, dst = results.get(i, ("", ""))
        seg = segments[i]
        if fixed:
            seg["text"] = fixed
        if dst:
            seg["translated"] = dst
        n = len(dst or "")
        flag = "" if n <= it["budget"] else "  OVER"
        report.append(
            f"[{i:02d}] {seg['start']:.2f}-{seg['end']:.2f}s "
            f"budget={it['budget']} got={n}{flag}\n"
            f"     ASR:   {it['src']}\n"
            f"     FIXED: {seg.get('text','')}\n"
            f"     {target_lang.upper()}: {seg.get('translated','')}")
    return report
