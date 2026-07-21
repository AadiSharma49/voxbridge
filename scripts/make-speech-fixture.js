/**
 * Regenerates the speech fixture used by the Silero integration test.
 *
 * Uses the OS text-to-speech engine so no audio recording is needed. Windows
 * only for now; on other platforms install the fixture manually or generate a
 * 16 kHz mono 16-bit WAV with any tool (say/espeak both work).
 */

const { spawnSync } = require('child_process');
const path = require('path');

const outputPath = path.join(__dirname, '..', 'test', 'fixtures', 'speech-16k-mono.wav');
const PHRASE = 'Hello. This is a test of the voice activity detector.';

const script = `
Add-Type -AssemblyName System.Speech
$dir = Split-Path -Parent '${outputPath.replace(/'/g, "''")}'
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
  16000,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile('${outputPath.replace(/'/g, "''")}', $fmt)
$s.Speak('${PHRASE}')
$s.Dispose()
`;

if (process.platform !== 'win32') {
  console.error(
    'This generator is Windows-only. Create a 16 kHz mono 16-bit WAV at:\n  ' +
    outputPath
  );
  process.exit(1);
}

const result = spawnSync(
  'powershell',
  ['-NoProfile', '-NonInteractive', '-Command', script],
  { stdio: 'inherit' }
);

if (result.status !== 0) {
  console.error('Failed to generate speech fixture');
  process.exit(1);
}

console.log(`Wrote ${outputPath}`);
