const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const modelsRoot = path.join(projectRoot, 'assets', 'models');
const modelFolders = [
  'vosk-model-small-en-us-0.15',
  'vosk-model-small-hi-0.22',
  'vosk-model-small-de-0.15',
  'vosk-model-small-fr-0.22',
  'vosk-model-small-cn-0.22',
  'vosk-model-small-es-0.42'
];

function copyModelToArchiveRoot(sourceDir, tempModelDir) {
  fs.mkdirSync(tempModelDir, { recursive: true });
  fs.cpSync(sourceDir, tempModelDir, {
    recursive: true,
    force: true,
    dereference: true
  });
}

function createArchive(modelName) {
  const sourceDir = path.join(modelsRoot, modelName);
  const archivePath = path.join(modelsRoot, `${modelName}.tar.gz`);

  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    return;
  }

  if (fs.existsSync(archivePath)) {
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'voxbridge-model-'));
  const tempModelDir = path.join(tempRoot, 'model');

  try {
    console.log(`[Models] Creating ${path.basename(archivePath)} from extracted model folder...`);
    copyModelToArchiveRoot(sourceDir, tempModelDir);

    const result = spawnSync('tar', ['-czf', archivePath, '-C', tempRoot, 'model'], {
      stdio: 'inherit'
    });

    if (result.status !== 0) {
      throw new Error(`tar exited with status ${result.status}`);
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function prepareModelArchives() {
  if (!fs.existsSync(modelsRoot)) {
    return;
  }

  modelFolders.forEach(createArchive);
}

if (require.main === module) {
  prepareModelArchives();
}

module.exports = {
  prepareModelArchives
};
