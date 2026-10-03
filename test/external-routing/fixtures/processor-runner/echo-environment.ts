const inputChunks: Buffer[] = [];

for await (const chunk of process.stdin) {
  inputChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
}

process.stderr.write('processor diagnostic');
process.stdout.write(
  JSON.stringify({
    stdinBase64: Buffer.concat(inputChunks).toString('base64'),
    environment: {
      role: process.env.CUSTOM_MCP_PROCESSOR_ROLE ?? null,
      callId: process.env.CUSTOM_MCP_EXTERNAL_CALL_ID ?? null,
      httpStatus: process.env.CUSTOM_MCP_EXTERNAL_HTTP_STATUS ?? null,
      contentType: process.env.CUSTOM_MCP_EXTERNAL_CONTENT_TYPE ?? null,
      contentEncoding: process.env.CUSTOM_MCP_EXTERNAL_CONTENT_ENCODING ?? null,
      inheritedExternalVariable: process.env.CUSTOM_MCP_EXTERNAL_UNRELATED ?? null,
    },
  }),
);
