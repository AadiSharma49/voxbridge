/**
 * AudioCapture
 *
 * Produces a stream of 16 kHz mono Float32 frames from one of two sources:
 *
 *   'system' - the audio coming OUT of the speakers. This is what the other
 *              person in a call is saying, and is the source that makes live
 *              translation useful. Requires loopback support from the platform.
 *   'mic'    - the local microphone, i.e. our own voice.
 *
 * Frames are emitted as plain Float32Array (not AudioBuffer) so that speech
 * engines can consume them without depending on Web Audio types.
 */

export const SAMPLE_RATE = 16000;
const FRAME_SIZE = 4096;

/** Below this RMS a frame is treated as digital silence. */
const SILENCE_RMS = 0.0008;

/** How often the capture level is reported, in frames (~4s at 16 kHz). */
const LEVEL_REPORT_INTERVAL = 16;

function computeRms(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) {
    sum += frame[i] * frame[i];
  }
  return Math.sqrt(sum / frame.length);
}

export class AudioCapture {
  constructor() {
    this.stream = null;
    this.audioContext = null;
    this.sourceNode = null;
    this.processorNode = null;
    this.silenceNode = null;
    this.sourceType = null;
    this.frameCount = 0;
    this.level = 0;
    this.silentFrames = 0;
    /** @type {((level: number) => void) | null} */
    this.onLevel = null;
  }

  get isActive() {
    return this.stream !== null;
  }

  /**
   * @param {(frame: Float32Array) => void} onAudioFrame
   * @param {{ sourceType?: 'system' | 'mic', deviceId?: string }} options
   */
  async start(onAudioFrame, options = {}) {
    if (this.stream) {
      return;
    }

    const sourceType = options.sourceType || 'system';
    this.sourceType = sourceType;

    this.stream = sourceType === 'system'
      ? await this.#openSystemAudioStream()
      : await this.#openMicrophoneStream(options.deviceId);

    if (!this.stream.getAudioTracks().length) {
      await this.stop();
      throw new Error(
        'No audio track was returned. On macOS, system audio requires a virtual ' +
        'audio device such as BlackHole; select it as the input source instead.'
      );
    }

    // Resampling to 16 kHz is done by the AudioContext itself, which is both
    // simpler and higher quality than decimating frames by hand.
    this.audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    await this.audioContext.resume();

    this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);

    // ScriptProcessorNode is deprecated but is the least fragile option here:
    // AudioWorklet would need a separate module file served over the internal
    // HTTP server plus a message port for every frame.
    this.processorNode = this.audioContext.createScriptProcessor(FRAME_SIZE, 1, 1);
    this.frameCount = 0;
    this.level = 0;
    this.silentFrames = 0;

    this.processorNode.onaudioprocess = (event) => {
      this.frameCount += 1;
      // Copy: the underlying buffer is reused by the audio thread between calls.
      const frame = new Float32Array(event.inputBuffer.getChannelData(0));

      this.level = computeRms(frame);
      if (this.level < SILENCE_RMS) {
        this.silentFrames += 1;
      } else {
        this.silentFrames = 0;
      }

      this.#reportLevel();
      onAudioFrame(frame);
    };

    // The processor only runs while connected to the destination, but routing
    // captured audio back to the speakers would cause an echo loop, so it is
    // muted with a zero-gain node first.
    this.silenceNode = this.audioContext.createGain();
    this.silenceNode.gain.value = 0;

    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(this.silenceNode);
    this.silenceNode.connect(this.audioContext.destination);

    console.info('[AudioCapture] Started', {
      sourceType,
      sampleRate: this.audioContext.sampleRate,
      tracks: this.stream.getAudioTracks().map((t) => t.label)
    });
  }

  /**
   * Periodically reports the capture level. This is the diagnostic that
   * distinguishes "no audio is arriving at all" from "audio is arriving but
   * it is silent" — the two failures look identical from the outside.
   */
  #reportLevel() {
    // The meter updates on every frame so it tracks speech smoothly; the
    // console is far noisier than useful at that rate, so it lags behind.
    this.onLevel?.(this.level);

    if (this.frameCount % LEVEL_REPORT_INTERVAL !== 0) {
      return;
    }

    const silentSeconds = ((this.silentFrames * FRAME_SIZE) / SAMPLE_RATE).toFixed(1);

    if (this.silentFrames >= LEVEL_REPORT_INTERVAL) {
      console.warn(
        `[AudioCapture] ${this.sourceType} silent for ${silentSeconds}s ` +
        `(rms ${this.level.toFixed(5)}). ` +
        (this.sourceType === 'system'
          ? 'System audio captures what your SPEAKERS play, not your microphone. ' +
            'Play a video, or switch "Listen to" to Microphone.'
          : 'Check the microphone is not muted at the OS level.')
      );
    } else {
      console.info(
        `[AudioCapture] ${this.sourceType} level rms=${this.level.toFixed(4)} ` +
        `frames=${this.frameCount}`
      );
    }
  }

  async #openSystemAudioStream() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('System audio capture is not available in this environment.');
    }

    // The main process intercepts this and grants loopback audio. A video track
    // must be requested for the request to succeed, but it is dropped below.
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    // Keeping the screen video track alive would burn CPU encoding frames
    // nobody looks at.
    for (const track of stream.getVideoTracks()) {
      track.stop();
      stream.removeTrack(track);
    }

    return stream;
  }

  async #openMicrophoneStream(deviceId) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone access is not available in this environment.');
    }

    return navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        channelCount: 1,
        sampleRate: SAMPLE_RATE,
        echoCancellation: true,
        noiseSuppression: true
      }
    });
  }

  /**
   * Lists selectable input devices. On Linux, ".monitor" devices are the
   * PulseAudio loopback fallback when PipeWire is unavailable.
   */
  static async listInputDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return [];
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === 'audioinput')
      .map((device) => ({
        deviceId: device.deviceId,
        label: device.label || 'Unnamed input',
        isMonitor: /monitor|loopback|stereo mix|blackhole|soundflower/i.test(device.label)
      }));
  }

  async stop() {
    if (this.processorNode) {
      this.processorNode.onaudioprocess = null;
      this.processorNode.disconnect();
      this.processorNode = null;
    }

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.silenceNode) {
      this.silenceNode.disconnect();
      this.silenceNode = null;
    }

    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }

    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }

    this.sourceType = null;
    this.frameCount = 0;
    this.level = 0;
    this.silentFrames = 0;
  }
}
