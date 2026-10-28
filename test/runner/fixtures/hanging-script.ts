// Independent escape hatch: a regression in the runner must not leave this alive.
setTimeout(() => process.exit(93), 10_000);
console.log('hanging fixture stdout');
console.error('hanging fixture stderr');
process.stdout.write('x'.repeat(300 * 1024));
setInterval(() => {}, 1_000);
