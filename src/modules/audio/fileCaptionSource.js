/**
 * FileCaptionSource
 *
 * The friction-free way to test VoxBridge: instead of routing system audio,
 * pick an audio or video file. It plays the sound so you hear it, and at the
 * same time feeds the audio into the exact same caption pipeline as live
 * capture — so captions appear in sync, with no audio setup at all.
 *
 * The audio is decoded once, resampled to the 16 kHz mono the speech engine
 * expects, and pushed frame-by-frame paced to real time so the caption timing
 * matches what you would see watching live.
 */

const TARGET_RATE = 16000;
const FRAME_SIZE = 4096;
const FRAME_MS = (FRAME_SIZE / TARGET_RATE) * 1000; // ~256ms

export class FileCaptionSource {
  constructor() {
    this.playbackContext = null;
    this.sourceNode = null;
    this.gainNode = null;
    this.decoded = null;
    this.frames = [];
    this.frameIndex = 0;
    this.startedAt = 0;
    this.rafActive = false;
    this.onFrame = null;
    this.onLevel = null;
    this.onEnded = null;
  }

  get isActive() {
    return this.rafActive;
  }

  /**
   * Decodes a File and prepares 16 kHz mono frames.
   * @param {File} file
   * @returns {Promise<{durationSeconds:number, name:string}>}
   */
  async load(file) {
    const bytes = await file.arrayBuffer();

    // A short-lived context just to decode; the file may be any sample rate.
    const decodeContext = new AudioContext();
    let decoded;
    try {
      decoded = await decodeContext.decodeAudioData(bytes);
    } catch (error) {
      await decodeContext.close();
      throw new Error(
        `Could not read audio from "${file.name}". Try an MP3, WAV, M4A, or a video file with sound.`
      );
    }
    await decodeContext.close();

    this.decoded = decoded;
    this.frames = await this.#toFrames(decoded);
    this.frameIndex = 0;

    if (!this.frames.length) {
      throw new Error(`"${file.name}" has no usable audio.`);
    }

    return { durationSeconds: decoded.duration, name: file.name };
  }

  /** Renders the decoded buffer down to 16 kHz mono and slices it into frames. */
  async #toFrames(decoded) {
    const length = Math.ceil(decoded.duration * TARGET_RATE);
    const offline = new OfflineAudioContext(1, length, TARGET_RATE);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();

    const rendered = await offline.startRendering();
    const mono = rendered.getChannelData(0);

    const frames = [];
    for (let i = 0; i + FRAME_SIZE <= mono.length; i += FRAME_SIZE) {
      frames.push(mono.slice(i, i + FRAME_SIZE));
    }
    return frames;
  }

  /**
   * Plays the audio aloud and feeds frames to the caption pipeline in sync.
   * @param {(frame: Float32Array) => void} onFrame
   * @param {{ onLevel?: (rms:number)=>void, onEnded?: ()=>void }} [handlers]
   */
  async start(onFrame, handlers = {}) {
    if (!this.decoded) {
      throw new Error('FileCaptionSource.load() must be called before start()');
    }

    this.onFrame = onFrame;
    this.onLevel = handlers.onLevel || null;
    this.onEnded = handlers.onEnded || null;

    // Play so the user hears the clip. Routed through a gain node so the
    // original can be ducked while the spoken translation talks over it —
    // which is what makes the file test feel like a real dub.
    this.playbackContext = new AudioContext();
    await this.playbackContext.resume();
    this.sourceNode = this.playbackContext.createBufferSource();
    this.sourceNode.buffer = this.decoded;
    this.gainNode = this.playbackContext.createGain();
    this.sourceNode.connect(this.gainNode);
    this.gainNode.connect(this.playbackContext.destination);

    this.frameIndex = 0;
    this.rafActive = true;
    this.startedAt = this.playbackContext.currentTime;
    this.sourceNode.start();

    // Drive frame delivery off the audio clock rather than a fixed timer, so
    // the captions cannot drift away from the sound the user is hearing.
    this.#pump();
  }

  #pump() {
    if (!this.rafActive) return;

    const elapsedMs = (this.playbackContext.currentTime - this.startedAt) * 1000;
    const dueIndex = Math.floor(elapsedMs / FRAME_MS);

    while (this.frameIndex <= dueIndex && this.frameIndex < this.frames.length) {
      const frame = this.frames[this.frameIndex++];
      this.onLevel?.(rms(frame));
      this.onFrame?.(frame);
    }

    if (this.frameIndex >= this.frames.length) {
      this.#finish();
      return;
    }

    requestAnimationFrame(() => this.#pump());
  }

  /**
   * Sets the original clip's volume (0–1) with a short ramp to avoid clicks.
   * Used to duck the source while the translated voice speaks over it.
   */
  setVolume(value) {
    if (!this.gainNode || !this.playbackContext) return;
    const clamped = Math.min(1, Math.max(0, value));
    this.gainNode.gain.setTargetAtTime(
      clamped,
      this.playbackContext.currentTime,
      0.05
    );
  }

  #finish() {
    this.rafActive = false;
    const done = this.onEnded;
    this.onEnded = null;
    done?.();
  }

  async stop() {
    this.rafActive = false;

    if (this.sourceNode) {
      try { this.sourceNode.stop(); } catch { /* already stopped */ }
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.gainNode) {
      this.gainNode.disconnect();
      this.gainNode = null;
    }
    if (this.playbackContext) {
      await this.playbackContext.close();
      this.playbackContext = null;
    }
  }
}

function rms(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}
