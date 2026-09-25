'use strict';
// Print-job bookkeeping shared by the browser and the server (which closes jobs when the printer finishes).
// Every function mutates a workspace copy in place; callers save it.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Ledger = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const byId = (list, id) => list.find(x => x.id === id);

  // Keeps spool stock in step with a job: refund what it used before, then charge finished prints.
  function settle(next, job) {
    if (job.charge) {
      const old = byId(next.spools, job.charge.spoolId);
      if (old) old.remainingGrams = Math.min(old.totalGrams, old.remainingGrams + job.charge.grams);
      job.charge = null;
    }
    const spool = job.spoolId && byId(next.spools, job.spoolId);
    if (spool && ['Succeeded', 'Failed'].includes(job.status) && job.grams > 0) {
      const grams = Math.min(job.grams, spool.remainingGrams);
      spool.remainingGrams = Math.round((spool.remainingGrams - grams) * 10) / 10;
      job.charge = {spoolId:spool.id, grams};
    }
  }

  // Moves a job to Printing / Succeeded / Failed / Cancelled and nudges its project along.
  // Returns {autoDone} when the project was marked Done because its last open print succeeded.
  function transition(next, jobId, to, at, extra = {}) {
    const job = byId(next.jobs, jobId), project = byId(next.projects, job.projectId);
    let autoDone = false;
    job.status = to;
    Object.assign(job, extra);
    if (to === 'Printing') {
      if (!extra.startedAt) job.startedAt = at;
      job.finishedAt = '';
      if (['Idea', 'Planned'].includes(project.status)) project.status = 'Printing';
    } else {
      job.finishedAt = at;
      if (to !== 'Cancelled' && job.startedAt && job.actualMinutes === null) job.actualMinutes = Math.max(1, Math.round((Date.parse(at) - Date.parse(job.startedAt)) / 60000));
    }
    if (to === 'Succeeded' && project.status === 'Printing' && !next.jobs.some(j => j.projectId === project.id && ['Queued', 'Printing'].includes(j.status))) { project.status = 'Done'; autoDone = true; }
    project.updatedAt = at;
    settle(next, job);
    return {autoDone};
  }

  return {settle, transition};
});
