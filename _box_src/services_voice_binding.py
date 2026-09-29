"""Keep every dub segment pointing at its detected speaker's voice.

The transcribe stream binds each segment to its speaker's auto-clone once, by writing
``profile_id`` onto the segment. Anything that rewrites ``job["segments"]`` afterwards can
drop that field, and ``dub_generate._remote_voice`` branches solely on ``profile_id`` - so a
segment without one is synthesised in the model's default voice while its cloned reference
sits unused on disk. That is a silent failure: the speaker label still shows correctly in the
editor, only the Voice column quietly reads "Default".

This lives in its own module on purpose. It is a correctness fix, not a speed change, so it
must not be undone by the speed revert scripts - and it only uses ``auto_profile_id`` and
``build_cast_sources``, which are original functions present in every backup of
``speaker_clone.py``.
"""

import logging

logger = logging.getLogger("omnivoice.voice_binding")


def ensure_segment_bindings(job: dict) -> int:
    """Give every unbound segment its detected speaker's auto-clone id.

    Idempotent and conservative:

    * a segment that already has a ``profile_id`` is left alone, so a voice the user picked
      in the editor is never overridden;
    * a speaker with no usable source in ``cast_sources`` is not invented one - it keeps
      falling back to the default voice, which is the honest result;
    * ``cast_sources`` is rebuilt from whatever clones the job has when the key is absent,
      so jobs written before it existed are still healed.

    Returns the number of segments newly bound.
    """
    from services.speaker_clone import auto_profile_id, build_cast_sources

    segs = [s for s in (job.get("segments") or []) if isinstance(s, dict)]
    if not segs:
        return 0

    cast = job.get("cast_sources")
    if not cast:
        cast = build_cast_sources(
            segs, job.get("speaker_clones"), job.get("segment_clones")
        )
        if cast:
            job["cast_sources"] = cast
    if not cast:
        return 0

    bound = 0
    for s in segs:
        if s.get("profile_id"):
            continue
        spk = s.get("speaker_id") or "Speaker 1"
        if spk in cast:
            s["profile_id"] = auto_profile_id(spk)
            bound += 1
    if bound:
        logger.info("bound %d segment(s) to their speaker's voice", bound)
    return bound
