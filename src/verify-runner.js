'use strict';

function createVerifyRunner(deps) {
  const state = {
    queue: [],
    active: null,
    idleResolvers: [],
    pumping: false,
  };

  async function emit(event) {
    if (deps.onEvent) {
      await deps.onEvent(event);
    }
  }

  function resolveIdleIfNeeded() {
    if (state.active || state.queue.length > 0 || state.pumping) {
      return;
    }
    const resolvers = state.idleResolvers.splice(0, state.idleResolvers.length);
    for (const resolve of resolvers) {
      resolve();
    }
  }

  async function pump() {
    if (state.pumping) {
      return;
    }
    state.pumping = true;
    try {
      while (!state.active && state.queue.length > 0) {
        const job = state.queue.shift();
        state.active = job;
        job.status = 'running';
        job.startedAt = Date.now();
        await emit({ type: 'verify.started', job: job });
        const result = await deps.runJob(job);
        job.status = result.code === 0 ? 'passed' : 'failed';
        job.finishedAt = Date.now();
        job.lastExitCode = result.code;
        job.lastOutput = result.output || '';
        await emit({ type: 'verify.finished', job: job, result: result });
        state.active = null;
      }
    } finally {
      state.pumping = false;
      resolveIdleIfNeeded();
    }
  }

  return {
    async enqueue(job) {
      state.queue.push(job);
      await emit({ type: 'verify.queued', job: job });
      pump().catch(() => {});
      return job;
    },
    whenIdle() {
      if (!state.active && state.queue.length === 0 && !state.pumping) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        state.idleResolvers.push(resolve);
      });
    },
  };
}

module.exports = { createVerifyRunner };
