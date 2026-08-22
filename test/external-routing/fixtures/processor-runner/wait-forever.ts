process.on('SIGTERM', () => {
  // Used by bounded-cleanup tests; the runner must escalate after its grace period.
});

setInterval(() => {}, 1_000);
