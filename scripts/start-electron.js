const { spawn } = require('child_process');
const electronBinary = require('electron');
const path = require('path');
const { prepareModelArchives } = require('./prepare-model-archives');

const projectRoot = path.join(__dirname, '..');
const env = { ...process.env };

prepareModelArchives();

// Some shells leave this set, which makes Electron behave like plain Node and breaks app startup.
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBinary, [projectRoot], {
  cwd: projectRoot,
  stdio: 'inherit',
  env
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

child.on('error', (error) => {
  console.error('Failed to launch Electron:', error);
  process.exit(1);
});
