process.stderr.write(Buffer.alloc(1024 * 1024 + 257, 'e'), () => {
  process.stdout.write('stderr-drained');
});
