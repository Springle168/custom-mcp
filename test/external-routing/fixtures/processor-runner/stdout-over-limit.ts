process.stdout.on('error', () => {
  // The parent deliberately destroys stdout after enforcing its fixed output limit.
});
process.stdout.write(Buffer.alloc(50 * 1024 * 1024 + 1, 'o'));
