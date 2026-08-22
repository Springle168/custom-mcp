process.stdout.write('untrusted stdout must not escape a failed Processor');
process.stderr.write('untrusted stderr must not escape a failed Processor');
process.exitCode = 7;
