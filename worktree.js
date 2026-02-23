const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const sysEnv = {
  ...process.env,
  PATH: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', process.env.PATH || ''].join(':'),
  LANG: process.env.LANG || 'en_US.UTF-8'
};

function git(args, cwd, silent = false) {
  try {
    const out = execFileSync('git', args, { cwd, env: sysEnv, timeout: 10000, encoding: 'utf8' });
    return { ok: true, stdout: (out || '').trim() };
  } catch (e) {
    if (!silent) console.error(`[worktree] git ${args.join(' ')}:`, e.message);
    return { ok: false, stdout: '', error: e.message };
  }
}

function isGitRepo(dir) {
  const r = git(['rev-parse', '--is-inside-work-tree'], dir, true);
  return r.ok && r.stdout === 'true';
}

// Returns the root of the main repo (follows git-common-dir for worktrees)
function getRepoRoot(dir) {
  const commonDir = git(['rev-parse', '--git-common-dir'], dir, true);
  if (!commonDir.ok) return null;
  // --git-common-dir returns e.g. "/repo/.git" (main repo) or "/repo/.git/worktrees/foo"
  // For a main repo, it's just ".git" (relative) or absolute ".git" path
  const resolved = path.resolve(dir, commonDir.stdout);
  // The repo root is the parent of the .git dir
  // But for worktrees, --git-common-dir returns the main repo's .git dir
  if (resolved.endsWith('.git')) {
    return path.dirname(resolved);
  }
  // If it doesn't end with .git, use --show-toplevel on the common dir's parent
  // This shouldn't normally happen, but handle it gracefully
  const toplevel = git(['rev-parse', '--show-toplevel'], dir, true);
  return toplevel.ok ? toplevel.stdout : null;
}

function createWorktree(repoDir, branch) {
  const safeName = branch.replace(/\//g, '-');
  const wtDir = path.join(repoDir, '.worktrees');
  const wtPath = path.join(wtDir, safeName);

  // Ensure .worktrees dir exists
  if (!fs.existsSync(wtDir)) fs.mkdirSync(wtDir, { recursive: true });

  // Ensure .worktrees/ is gitignored
  ensureGitignored(repoDir);

  // Try creating with new branch
  let r = git(['worktree', 'add', '-b', branch, wtPath, 'HEAD'], repoDir);
  if (r.ok) return { ok: true, worktreePath: wtPath, branch };

  // Branch might already exist — try without -b
  r = git(['worktree', 'add', wtPath, branch], repoDir, true);
  if (r.ok) return { ok: true, worktreePath: wtPath, branch };

  // Branch exists and is checked out elsewhere — try with suffix
  for (let i = 2; i <= 10; i++) {
    const altBranch = `${branch}-${i}`;
    const altSafe = altBranch.replace(/\//g, '-');
    const altPath = path.join(wtDir, altSafe);
    r = git(['worktree', 'add', '-b', altBranch, altPath, 'HEAD'], repoDir, true);
    if (r.ok) return { ok: true, worktreePath: altPath, branch: altBranch };
  }

  return { ok: false, error: 'could not create worktree (branch conflict)' };
}

function removeWorktree(repoDir, wtPath) {
  // Remove the worktree
  const r = git(['worktree', 'remove', '--force', wtPath], repoDir);

  // Try to delete the branch too
  // Extract branch name: list worktrees to find which branch was at wtPath
  // Since the worktree is already removed, just try to delete the branch by convention
  // The caller should provide the branch name if they want it deleted
  return r;
}

function removeBranch(repoDir, branch) {
  return git(['branch', '-D', branch], repoDir, true);
}

function listWorktrees(repoDir) {
  const r = git(['worktree', 'list', '--porcelain'], repoDir, true);
  if (!r.ok) return [];

  const worktrees = [];
  let current = {};
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.worktree) worktrees.push(current);
      current = { worktree: line.slice(9) };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice(5);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice(7);
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line === '') {
      if (current.worktree) worktrees.push(current);
      current = {};
    }
  }
  if (current.worktree) worktrees.push(current);
  return worktrees;
}

function ensureGitignored(repoDir) {
  const gitignorePath = path.join(repoDir, '.gitignore');
  const entry = '.worktrees/';
  try {
    let content = '';
    if (fs.existsSync(gitignorePath)) {
      content = fs.readFileSync(gitignorePath, 'utf8');
    }
    // Check if already present (exact line match)
    const lines = content.split('\n');
    if (lines.some(l => l.trim() === entry)) return;
    // Append
    const suffix = content.endsWith('\n') || content === '' ? '' : '\n';
    fs.writeFileSync(gitignorePath, content + suffix + entry + '\n', 'utf8');
    console.log(`[worktree] added ${entry} to .gitignore`);
  } catch (e) {
    console.error('[worktree] ensureGitignored:', e.message);
  }
}

module.exports = {
  isGitRepo,
  getRepoRoot,
  createWorktree,
  removeWorktree,
  removeBranch,
  listWorktrees,
  ensureGitignored
};
