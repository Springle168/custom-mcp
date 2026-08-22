process.stdout.on('error', () => {
  // The runner may detach the inherited pipe after bounded cleanup.
});
process.stderr.on('error', () => {
  // The runner may detach the inherited pipe after bounded cleanup.
});

process.send?.('ready');

setTimeout(() => {
  process.exit(0);
}, 600);
