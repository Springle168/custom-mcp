import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { gzipSync } from 'node:zlib';
import type { ExternalHttpEndpointConfig } from '../../src/tools/external-routing/config.js';
import {
  MAX_EXTERNAL_HTTP_BODY_BYTES,
  createExternalHttpTransport,
  type ExternalHttpTransportFailure,
  type ExternalHttpTransportOutcome,
  type ExternalHttpTransportSuccess,
} from '../../src/tools/external-routing/http-transport.js';
import { assert, assertEqual, assertNotIncludes, runTestSuite } from '../test-utils.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface LoopbackServer {
  readonly baseUrl: string;
  readonly sockets: ReadonlySet<Socket>;
  close(): Promise<void>;
}

async function startLoopbackServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<LoopbackServer> {
  const server = createServer(handler);
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  assert(
    address !== null && typeof address !== 'string',
    'Loopback server should expose a TCP port.',
  );
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    sockets,
    close: () => closeServer(server, sockets),
  };
}

async function startRawLoopbackServer(handler: (socket: Socket) => void): Promise<LoopbackServer> {
  const server = createNetServer();
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    handler(socket);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  assert(
    address !== null && typeof address !== 'string',
    'Raw loopback server should expose a TCP port.',
  );
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    sockets,
    close: () => closeRawServer(server, sockets),
  };
}

async function closeServer(server: Server, sockets: ReadonlySet<Socket>): Promise<void> {
  for (const socket of sockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function closeRawServer(server: NetServer, sockets: ReadonlySet<Socket>): Promise<void> {
  for (const socket of sockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function endpoint(
  server: LoopbackServer,
  overrides: Partial<ExternalHttpEndpointConfig> = {},
): ExternalHttpEndpointConfig {
  return {
    url: `${server.baseUrl}/external/tool?tenant=loopback`,
    timeoutMs: 1_000,
    headers: {},
    ...overrides,
  };
}

function success(outcome: ExternalHttpTransportOutcome): ExternalHttpTransportSuccess {
  assert(outcome.ok, 'Expected the HTTP exchange to succeed.');
  return outcome;
}

function failure(outcome: ExternalHttpTransportOutcome): ExternalHttpTransportFailure {
  assert(!outcome.ok, 'Expected the HTTP exchange to fail.');
  return outcome;
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting: ${message}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function responseJson(response: ServerResponse, body = '{"results":[]}'): void {
  response.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
  });
  response.end(body);
}

async function testPostHeadersLengthAndRawBody(): Promise<void> {
  let method = '';
  let url = '';
  let headers: IncomingMessage['headers'] | undefined;
  let body = Buffer.alloc(0);
  const server = await startLoopbackServer((request, response) => {
    method = request.method ?? '';
    url = request.url ?? '';
    headers = request.headers;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      body = Buffer.concat(chunks);
      response.writeProcessing();
      response.writeHead(201, {
        'Content-Type': ' Application/JSON; Charset="UTF-8" ',
        'Content-Encoding': 'IDENTITY',
      });
      response.end('{"results":[]}');
    });
  });
  const requestBody = new Uint8Array([0, 1, 2, 255]);
  const transport = createExternalHttpTransport(
    endpoint(server, {
      headers: {
        Authorization: 'Bearer configured-secret',
        'X-Route': 'loopback',
      },
    }),
  );

  try {
    const exchange = transport.exchange({
      body: requestBody,
      contentType: 'application/json; charset=utf-8',
      responseMode: 'direct',
    });
    const outcome = success(await exchange.settled);
    await exchange.drained;

    assertEqual(method, 'POST', 'Transport must always use POST.');
    assertEqual(
      url,
      '/external/tool?tenant=loopback',
      'Endpoint path and query must reach the target.',
    );
    assertEqual(
      headers?.authorization,
      'Bearer configured-secret',
      'Configured static headers should be sent.',
    );
    assertEqual(headers?.['x-route'], 'loopback', 'Configured end-to-end headers should be sent.');
    assertEqual(
      headers?.['content-type'],
      'application/json; charset=utf-8',
      'Strategy owns Content-Type.',
    );
    assertEqual(headers?.['content-length'], '4', 'Transport must send exact final byte length.');
    assertEqual(
      headers?.['accept-encoding'],
      undefined,
      'Transport must not negotiate response compression.',
    );
    assert(
      Buffer.from(body).equals(Buffer.from(requestBody)),
      'Request body must retain its final raw bytes.',
    );
    assertEqual(
      outcome.statusCode,
      201,
      'Final non-redirect status should be returned without canonical parsing.',
    );
    assertEqual(
      outcome.contentType,
      'Application/JSON; Charset="UTF-8"',
      'Content-Type metadata should be trimmed but preserve its validated field value.',
    );
    assertEqual(
      outcome.contentEncoding,
      'identity',
      'Content-Encoding should be normalized for consumers.',
    );
    assertEqual(
      decoder.decode(outcome.body),
      '{"results":[]}',
      'Response entity should be returned unchanged.',
    );
  } finally {
    await transport.close();
    await server.close();
  }
}

async function testRawEncodedEntityAndBodyDecoderHeaders(): Promise<void> {
  const encoded = gzipSync(Buffer.from('raw compressed response', 'utf-8'));
  const server = await startLoopbackServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'application/vnd.vendor+json; version=1',
      'Content-Encoding': 'GZip, Br',
    });
    response.end(encoded);
  });
  const transport = createExternalHttpTransport(endpoint(server));

  try {
    const exchange = transport.exchange({
      body: encoder.encode('{}'),
      contentType: 'application/json; charset=utf-8',
      responseMode: 'body-decoder',
    });
    const outcome = success(await exchange.settled);
    await exchange.drained;

    assert(
      Buffer.from(outcome.body).equals(encoded),
      'Transport must expose the original encoded entity bytes without decompression.',
    );
    assertEqual(
      outcome.contentType,
      'application/vnd.vendor+json; version=1',
      'Body decoders should receive validated arbitrary Content-Type metadata.',
    );
    assertEqual(
      outcome.contentEncoding,
      'gzip, br',
      'Content-Encoding tokens should normalize for processors.',
    );
  } finally {
    await transport.close();
    await server.close();
  }
}

async function testEarlyFinalResponseCannotWinOverPendingRequestFailure(): Promise<void> {
  const responseBody =
    '{"results":[{"id":"call_1","status":"completed","content":[{"type":"text","text":"done"}]}]}';
  const responseBytes = Buffer.from(
    [
      'HTTP/1.1 200 OK',
      'Content-Type: application/json; charset=utf-8',
      `Content-Length: ${Buffer.byteLength(responseBody)}`,
      'Connection: keep-alive',
      '',
      responseBody,
    ].join('\r\n'),
    'utf-8',
  );
  let responseSent = false;
  let resetIssued = false;
  let requestBytesBeforeResponse = 0;
  let resetTimer: NodeJS.Timeout | undefined;
  const server = await startRawLoopbackServer((socket) => {
    socket.on('error', () => undefined);
    socket.once('data', () => {
      requestBytesBeforeResponse = socket.bytesRead;
      socket.pause();
      responseSent = true;
      socket.write(responseBytes, () => {
        // Pausing after the first input chunk keeps the client's large request
        // pending while still allowing this complete final response to arrive.
        resetTimer = setTimeout(() => {
          resetIssued = true;
          socket.resetAndDestroy();
        }, 20);
      });
    });
  });
  const transport = createExternalHttpTransport(endpoint(server, { timeoutMs: 5_000 }));
  const largeRequestBody = new Uint8Array(MAX_EXTERNAL_HTTP_BODY_BYTES);

  try {
    const exchange = transport.exchange({
      body: largeRequestBody,
      contentType: 'application/json; charset=utf-8',
      responseMode: 'direct',
    });
    const outcome = failure(await exchange.settled);
    await exchange.drained;

    assert(responseSent, 'Raw endpoint should send the complete final response before resetting.');
    assert(resetIssued, 'Raw endpoint should reset the pending request connection.');
    assert(
      requestBytesBeforeResponse < largeRequestBody.byteLength,
      'Raw endpoint must answer before it has consumed the large request entity.',
    );
    assertEqual(
      outcome.code,
      'external_transport_failed',
      'A pending request write/connection failure must beat a staged final response.',
    );
    assertEqual(
      outcome.diagnostics.stage,
      'connection',
      'The winning outcome should identify the request connection failure.',
    );
    await waitFor(
      () => server.sockets.size === 0,
      'race failure should not leave a raw loopback socket open',
    );
  } finally {
    if (resetTimer) {
      clearTimeout(resetTimer);
    }
    await transport.close();
    await server.close();
  }
}

async function testRepresentationRulesAndDuplicateHeaders(): Promise<void> {
  let responseIndex = 0;
  const server = await startLoopbackServer((_request, response) => {
    const current = responseIndex++;
    if (current === 0) {
      response.writeHead(200, [
        'Content-Type',
        'application/json',
        'Content-Type',
        'application/json',
      ]);
      response.end('{}');
      return;
    }
    if (current === 1) {
      response.writeHead(200, [
        'Content-Type',
        'application/json',
        'Content-Encoding',
        'identity',
        'Content-Encoding',
        'identity',
      ]);
      response.end('{}');
      return;
    }
    if (current === 2) {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=latin1' });
      response.end('{}');
      return;
    }
    if (current === 3) {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8; charset=utf-8' });
      response.end('{}');
      return;
    }
    if (current === 4) {
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
      });
      response.end('{}');
      return;
    }
    response.writeHead(200);
    response.end('{}');
  });
  const transport = createExternalHttpTransport(endpoint(server));

  try {
    for (const path of [
      '/duplicate-type',
      '/duplicate-encoding',
      '/latin1',
      '/duplicate-charset',
      '/compressed-direct',
      '/missing-content-type',
    ]) {
      const exchange = transport.exchange({
        body: encoder.encode('{}'),
        contentType: 'application/json; charset=utf-8',
        responseMode: 'direct',
      });
      const result = failure(await exchange.settled);
      await exchange.drained;
      assertEqual(
        result.code,
        'external_protocol_failed',
        `${path} must fail response representation validation.`,
      );
    }
  } finally {
    await transport.close();
    await server.close();
  }
}

async function testEmptyFinalEntitiesAreProtocolFailures(): Promise<void> {
  let responseIndex = 0;
  const server = await startLoopbackServer((_request, response) => {
    const current = responseIndex++;
    if (current < 2) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
    } else {
      response.writeHead(200);
    }
    response.end();
  });
  const transport = createExternalHttpTransport(endpoint(server));

  try {
    for (const responseMode of ['direct', 'canonical-filter', 'body-decoder'] as const) {
      const exchange = transport.exchange({
        body: encoder.encode('{}'),
        contentType: 'application/json',
        responseMode,
      });
      const outcome = failure(await exchange.settled);
      await exchange.drained;
      assertEqual(
        outcome.code,
        'external_protocol_failed',
        `${responseMode} must reject an empty final HTTP entity body.`,
      );
    }
  } finally {
    await transport.close();
    await server.close();
  }
}

async function testStatusAndUpgradeOutcomesWithoutRedirectFollowing(): Promise<void> {
  let redirectRequests = 0;
  let responseIndex = 0;
  const server = await startLoopbackServer((_request, response) => {
    const current = responseIndex++;
    if (current === 0) {
      redirectRequests++;
      response.writeHead(302, { Location: '/should-not-be-requested' });
      response.end('redirect body');
      return;
    }
    if (current === 1) {
      response.writeHead(422, { 'Content-Type': 'application/json' });
      response.end('{"error":{"code":"invalid_request","message":"rejected"}}');
      return;
    }
    response.writeHead(101, { Connection: 'Upgrade', Upgrade: 'loopback-test' });
    response.end();
  });
  const transport = createExternalHttpTransport(endpoint(server));

  try {
    const redirect = failure(
      await transport.exchange({
        body: encoder.encode('{}'),
        contentType: 'application/json',
        responseMode: 'direct',
      }).settled,
    );
    assertEqual(
      redirect.code,
      'external_transport_failed',
      'A final 3xx must be a controlled redirect failure.',
    );
    assertEqual(
      redirect.diagnostics.statusCode,
      302,
      'Redirect diagnostics may retain only its status.',
    );
    assertEqual(
      redirectRequests,
      1,
      'Transport must never automatically follow redirects or retry.',
    );

    const rejection = success(
      await transport.exchange({
        body: encoder.encode('{}'),
        contentType: 'application/json',
        responseMode: 'direct',
      }).settled,
    );
    assertEqual(
      rejection.statusCode,
      422,
      '4xx/5xx responses should reach the response strategy unchanged.',
    );

    const upgrade = failure(
      await transport.exchange({
        body: encoder.encode('{}'),
        contentType: 'application/json',
        responseMode: 'direct',
      }).settled,
    );
    assertEqual(
      upgrade.code,
      'external_protocol_failed',
      '101/upgrade responses are not normal external responses.',
    );
  } finally {
    await transport.close();
    await server.close();
  }
}

async function testRequestAndResponseBodyLimits(): Promise<void> {
  let requestCount = 0;
  const server = await startLoopbackServer((_request, response) => {
    requestCount++;
    if (requestCount === 1) {
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': String(MAX_EXTERNAL_HTTP_BODY_BYTES + 1),
      });
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(Buffer.alloc(MAX_EXTERNAL_HTTP_BODY_BYTES + 1));
  });
  const transport = createExternalHttpTransport(endpoint(server));

  try {
    const tooLargeRequest = failure(
      await transport.exchange({
        body: new Uint8Array(MAX_EXTERNAL_HTTP_BODY_BYTES + 1),
        contentType: 'application/json',
        responseMode: 'direct',
      }).settled,
    );
    assertEqual(
      tooLargeRequest.code,
      'external_request_too_large',
      'Known oversized request bodies must not start HTTP.',
    );
    assertEqual(requestCount, 0, 'Known oversized request bodies must not reach the endpoint.');

    const knownResponse = failure(
      await transport.exchange({
        body: encoder.encode('{}'),
        contentType: 'application/json',
        responseMode: 'direct',
      }).settled,
    );
    assertEqual(
      knownResponse.code,
      'external_response_too_large',
      'Oversized Content-Length should fail before body accumulation.',
    );

    const streamingResponse = failure(
      await transport.exchange({
        body: encoder.encode('{}'),
        contentType: 'application/json',
        responseMode: 'direct',
      }).settled,
    );
    assertEqual(
      streamingResponse.code,
      'external_response_too_large',
      'Streaming responses must enforce the same entity limit.',
    );
  } finally {
    await transport.close();
    await server.close();
  }
}

async function testTimeoutAbortAndDedicatedAgentCleanup(): Promise<void> {
  let requests = 0;
  const server = await startLoopbackServer((request) => {
    requests++;
    request.resume();
    // Keep the response pending so the transport must own timeout/cancellation cleanup.
  });
  const transport = createExternalHttpTransport(endpoint(server, { timeoutMs: 25 }));

  try {
    const timeoutExchange = transport.exchange({
      body: encoder.encode('{}'),
      contentType: 'application/json',
      responseMode: 'direct',
    });
    const timedOut = failure(await timeoutExchange.settled);
    assertEqual(
      timedOut.code,
      'external_timeout',
      'Endpoint timeout must cover the whole active exchange.',
    );
    await timeoutExchange.drained;
    await waitFor(
      () => server.sockets.size === 0,
      'timeout should destroy the loopback request socket',
    );

    const controller = new AbortController();
    const abortExchange = transport.exchange({
      body: encoder.encode('{}'),
      contentType: 'application/json',
      responseMode: 'direct',
      signal: controller.signal,
    });
    await waitFor(() => requests >= 2, 'abort test request should reach the loopback server');
    controller.abort();
    const aborted = failure(await abortExchange.settled);
    assertEqual(
      aborted.code,
      'cancelled',
      'AbortSignal cancellation must use the local cancelled outcome.',
    );
    await abortExchange.drained;
    await waitFor(
      () => server.sockets.size === 0,
      'abort should destroy the loopback request socket',
    );
  } finally {
    await transport.close();
    await server.close();
  }
}

async function testIdempotentCloseAndSafeFailureDiagnostics(): Promise<void> {
  let requests = 0;
  const server = await startLoopbackServer((request, response) => {
    requests++;
    request.resume();
    if (requests === 1) {
      responseJson(response);
    }
    // Keep later requests pending to verify close waits for their local drain.
  });
  const transport = createExternalHttpTransport(endpoint(server));
  const invalidTransport = createExternalHttpTransport(
    endpoint(server, {
      url: `${server.baseUrl}/external/tool?query-secret=never-report`,
      headers: { Host: 'forbidden-host', Authorization: 'header-secret' },
    }),
  );

  try {
    const initial = success(
      await transport.exchange({
        body: encoder.encode('{}'),
        contentType: 'application/json',
        responseMode: 'direct',
      }).settled,
    );
    assertEqual(
      initial.statusCode,
      200,
      'Initial exchange should use the dedicated keep-alive Agent.',
    );

    const activeBeforeClose = transport.exchange({
      body: encoder.encode('{}'),
      contentType: 'application/json',
      responseMode: 'direct',
    });
    await waitFor(() => requests === 2, 'active close request should reach the loopback server');

    const firstClose = transport.close();
    const cancelled = failure(await activeBeforeClose.settled);
    assertEqual(
      cancelled.code,
      'cancelled',
      'close must cancel active HTTP exchanges before agent shutdown.',
    );
    await activeBeforeClose.drained;
    await firstClose;
    await transport.close();
    await waitFor(
      () => server.sockets.size === 0,
      'close should destroy dedicated Agent sockets after drain',
    );

    const afterClose = failure(
      await transport.exchange({
        body: encoder.encode('{}'),
        contentType: 'application/json',
        responseMode: 'direct',
      }).settled,
    );
    assertEqual(
      afterClose.code,
      'cancelled',
      'Closed transport must not admit a new HTTP exchange.',
    );
    assertEqual(requests, 2, 'Closed transport must not send additional requests.');

    const safeFailure = failure(
      await invalidTransport.exchange({
        body: encoder.encode('{}'),
        contentType: 'application/json',
        responseMode: 'direct',
      }).settled,
    );
    assertEqual(
      safeFailure.code,
      'external_transport_failed',
      'Invalid defensive transport input should be controlled.',
    );
    assertNotIncludes(
      safeFailure.message,
      'query-secret',
      'Failure message must not expose URL query data.',
    );
    assertNotIncludes(
      safeFailure.message,
      'header-secret',
      'Failure message must not expose header values.',
    );
  } finally {
    await transport.close();
    await invalidTransport.close();
    await server.close();
  }
}

async function testSelectsEndpointPerExchangeWithSharedAgents(): Promise<void> {
  const received: string[] = [];
  const first = await startLoopbackServer((request, response) => {
    received.push(`first:${request.headers['x-route'] ?? ''}`);
    responseJson(response);
  });
  const second = await startLoopbackServer((request, response) => {
    received.push(`second:${request.headers['x-route'] ?? ''}`);
    responseJson(response);
  });
  const transport = createExternalHttpTransport();

  try {
    const request = {
      body: encoder.encode('{}'),
      contentType: 'application/json; charset=utf-8',
      responseMode: 'direct' as const,
    };
    const firstOutcome = await transport.exchange({
      ...request,
      endpoint: endpoint(first, { headers: { 'X-Route': 'alpha' } }),
    }).settled;
    const secondOutcome = await transport.exchange({
      ...request,
      endpoint: endpoint(second, { headers: { 'X-Route': 'beta' } }),
    }).settled;

    assert(firstOutcome.ok, 'The first route endpoint should complete successfully.');
    assert(secondOutcome.ok, 'The second route endpoint should complete successfully.');
    assertEqual(
      received.join(','),
      'first:alpha,second:beta',
      'One transport owner should apply each exchange endpoint and its static headers.',
    );
  } finally {
    await transport.close();
    await first.close();
    await second.close();
  }
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing external-routing HTTP transport',
    tests: [
      {
        name: 'sends POST with owned headers, exact length, and raw body',
        run: testPostHeadersLengthAndRawBody,
      },
      {
        name: 'selects a route endpoint per exchange while sharing transport resources',
        run: testSelectsEndpointPerExchangeWithSharedAgents,
      },
      {
        name: 'preserves encoded response entities for body decoders',
        run: testRawEncodedEntityAndBodyDecoderHeaders,
      },
      {
        name: 'rejects early final responses when pending request writes fail',
        run: testEarlyFinalResponseCannotWinOverPendingRequestFailure,
      },
      {
        name: 'enforces representation metadata and duplicate field rules',
        run: testRepresentationRulesAndDuplicateHeaders,
      },
      {
        name: 'rejects empty final entities for every response mode',
        run: testEmptyFinalEntitiesAreProtocolFailures,
      },
      {
        name: 'handles final status classes without redirect or upgrade support',
        run: testStatusAndUpgradeOutcomesWithoutRedirectFollowing,
      },
      {
        name: 'enforces known and streaming request/response entity limits',
        run: testRequestAndResponseBodyLimits,
      },
      {
        name: 'settles timeout and abort while cleaning loopback sockets',
        run: testTimeoutAbortAndDedicatedAgentCleanup,
      },
      {
        name: 'destroys dedicated Agents idempotently without leaking diagnostics',
        run: testIdempotentCloseAndSafeFailureDiagnostics,
      },
    ],
  });
}

main().catch((error: unknown) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
