/**
 * 测试 ask_user 工具
 * 
 * 使用方法：
 * 1. 启动服务器：npm start
 * 2. 运行测试：npx tsx test/ask-user/ask-user.manual.ts
 * 3. 打开浏览器访问输出的 URL
 * 4. 填写表单并提交
 */

async function testAskUser() {
  const host = '127.0.0.1';
  const port = 3100;
  const endpoint = `http://${host}:${port}/mcp`;

  // 1. 初始化会话
  const initPayload = {
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'test-client',
        version: '1.0.0',
      },
    },
  };

  console.log('Initializing session...\n');

  const initResponse = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify(initPayload),
  });

  const sessionId = initResponse.headers.get('mcp-session-id');
  if (!sessionId) {
    console.error('Failed to get session ID');
    return;
  }

  console.log(`Session ID: ${sessionId}\n`);

  // 2. 调用工具
  const testPayload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'ask_user',
      arguments: {
        questions: [
          {
            question: 'Which authentication method should we use?',
            header: 'Auth method',
            type: 'choice',
            options: [
              {
                label: 'OAuth 2.0',
                description: 'Industry standard, supports SSO',
              },
              {
                label: 'JWT',
                description: 'Stateless, good for APIs',
              },
              {
                label: 'Session-based',
                description: 'Traditional, server-side storage',
              },
            ],
          },
          {
            question: 'Do you want to enable rate limiting?',
            header: 'Rate limiting',
            type: 'yesno',
          },
          {
            question: 'Please describe any additional requirements:',
            header: 'Requirements',
            type: 'text',
            placeholder: 'Enter your requirements here...',
          },
        ],
      },
    },
  };

  console.log('Calling ask_user tool...\n');
  console.log('(This will block until you submit the form in the browser)\n');

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify(testPayload),
  });

  if (!response.ok) {
    console.error(`HTTP error: ${response.status}`);
    const text = await response.text();
    console.error(text);
    return;
  }

  // 解析 SSE 流
  const text = await response.text();
  const lines = text.split('\n');
  let jsonData = '';

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      jsonData = line.substring(6); // 去掉 "data: " 前缀
      break;
    }
  }

  if (!jsonData) {
    console.error('No data found in SSE response');
    console.log('Raw response:', text);
    return;
  }

  const result = JSON.parse(jsonData);
  console.log('\nResponse received:');
  console.log(JSON.stringify(result, null, 2));

  if (result.result?.content?.[0]?.text) {
    const text = result.result.content[0].text;
    try {
      const parsed = JSON.parse(text);
      console.log('\nParsed answers:');
      console.log(JSON.stringify(parsed, null, 2));
    } catch {
      console.log('\nRaw response:', text);
    }
  }
}

testAskUser().catch(console.error);
