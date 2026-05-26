const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Create a temp test fixture directory with canonical planning layout.
 *
 * @param {object} [options]
 * @param {string} [options.prefix='gsd-test-']
 * @param {boolean} [options.git=false] - initialize git repo with initial commit
 * @param {boolean} [options.planning=true] - create .planning/phases layout
 * @param {boolean} [options.projectDoc=true] - write .planning/PROJECT.md
 * @returns {string} absolute fixture directory path
 */
function createFixture(options = {}) {
  const {
    prefix = 'gsd-test-',
    git = false,
    planning = true,
    projectDoc = git,
  } = options;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));

  if (planning) {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true });
  }

  if (projectDoc) {
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'PROJECT.md'),
      '# Project\n\nTest project.\n'
    );
  }

  if (git) {
    execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git config commit.gpgsign false', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git add -A', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git commit -m "initial commit"', { cwd: tmpDir, stdio: 'pipe' });
  }

  return tmpDir;
}

module.exports = { createFixture };
