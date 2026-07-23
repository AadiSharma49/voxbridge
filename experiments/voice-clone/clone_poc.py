"""
Voice-cloning proof of concept.

Proves the single unproven piece of the dubbing dream: can we take a sample of
someone's voice and make that same voice speak a different language, locally
and for free?

Uses XTTS v2 (Coqui), which does zero-shot voice cloning and supports Russian
and Hindi among ~17 languages. No GPU here, so this is slow — the point is
whether it WORKS, not whether it is fast.

Usage:
    python clone_poc.py --ref reference_voice.wav --text "..." --lang hi --out out/x.wav
"""

import argparse
import os
import sys
import time

# XTTS v2 is under a license that requires agreement; accept non-interactively.
os.environ.setdefault("COQUI_TOS_AGREED", "1")


def main():
    parser = argparse.ArgumentParser(description="Clone a voice into another language.")
    parser.add_argument("--ref", required=True, help="Reference voice WAV to clone")
    parser.add_argument("--text", required=True, help="Text to speak in the cloned voice")
    parser.add_argument("--lang", default="hi", help="Target language code (hi, en, ru, ...)")
    parser.add_argument("--out", required=True, help="Output WAV path")
    args = parser.parse_args()

    if not os.path.exists(args.ref):
        sys.exit(f"Reference voice not found: {args.ref}")

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)

    print(f"[POC] Loading XTTS v2 (first run downloads ~1.8GB)...", flush=True)
    load_started = time.time()

    import torch
    from TTS.api import TTS

    # Cap CPU threads so the machine stays usable during inference.
    torch.set_num_threads(max(1, (os.cpu_count() or 4) - 1))

    tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2")
    print(f"[POC] Model ready in {time.time() - load_started:.1f}s", flush=True)

    print(f"[POC] Cloning voice from {args.ref} -> {args.lang}", flush=True)
    gen_started = time.time()

    tts.tts_to_file(
        text=args.text,
        speaker_wav=args.ref,
        language=args.lang,
        file_path=args.out,
    )

    elapsed = time.time() - gen_started
    size_kb = os.path.getsize(args.out) / 1024
    print(
        f"[POC] Done in {elapsed:.1f}s -> {args.out} ({size_kb:.0f} KB)",
        flush=True,
    )


if __name__ == "__main__":
    main()
