'use strict';

const PLUGIN_ID = 'gsd-core';

async function loadPlugins() {
  const [core, worktree] = await Promise.all([
    import('./core-hooks.mjs'),
    import('./worktree-tool.mjs'),
  ]);
  return { core, worktree };
}

async function setup(ctx) {
  const { core, worktree } = await loadPlugins();
  const coreCleanup = await core.setupCorePlugin(ctx);
  let worktreeCleanup;
  try {
    worktreeCleanup = await worktree.setupWorktreePlugin(ctx);
  } catch (error) {
    try {
      await coreCleanup?.();
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'GSD core plugin setup failed and rollback was incomplete');
    }
    throw error;
  }

  let cleanupPromise;
  return () => {
    cleanupPromise ||= (async () => {
      const [worktreeResult] = await Promise.allSettled([
        Promise.resolve().then(() => worktreeCleanup?.()),
      ]);
      const [coreResult] = await Promise.allSettled([
        Promise.resolve().then(() => coreCleanup?.()),
      ]);
      const errors = [worktreeResult, coreResult]
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, 'GSD core plugin cleanup failed');
    })();
    return cleanupPromise;
  };
}

module.exports = { id: PLUGIN_ID, setup };
