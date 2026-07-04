// Minimal MCP (Model Context Protocol) server exposed as a Tencent EdgeOne Pages Function — a single
// HTTP endpoint implementing the MCP JSON-RPC methods a business assistant needs to discover and call
// this server's tools. No server process, no build step: EdgeOne runs this file directly as an edge
// function. Replace EXAMPLE_TOOL with a real one; add more the same way.

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<string> | string;
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'get_hello_message',
    description:
      'Returns a friendly greeting. Replace this with a tool that does something real for your business.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Who to greet.' },
      },
    },
    handler: (args) => {
      const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : 'there';
      return `Hello, ${name}! This MCP server is up and running.`;
    },
  },
];

const PROTOCOL_VERSION = '2024-11-05';

function jsonRpcResult(id: JsonRpcRequest['id'], result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }), {
    headers: { 'content-type': 'application/json' },
  });
}

function jsonRpcError(id: JsonRpcRequest['id'], code: number, message: string): Response {
  // JSON-RPC errors still reply with HTTP 200 — the error lives in the body, per the spec.
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

export async function onRequest({ request }: { request: Request }): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed — POST JSON-RPC requests only.', { status: 405 });
  }

  let body: JsonRpcRequest;
  try {
    body = await request.json();
  } catch {
    return jsonRpcError(null, -32700, 'Parse error: invalid JSON.');
  }
  if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return jsonRpcError(body.id ?? null, -32600, 'Invalid Request: expected a JSON-RPC 2.0 request.');
  }

  switch (body.method) {
    case 'initialize':
      return jsonRpcResult(body.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'my-mcp-server', version: '0.1.0' },
      });

    // A notification (no reply expected per the spec) — 204 with no body is the correct response.
    case 'notifications/initialized':
      return new Response(null, { status: 204 });

    case 'tools/list':
      return jsonRpcResult(body.id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });

    case 'tools/call': {
      const toolName = body.params?.name;
      const toolArgs = (body.params?.arguments as Record<string, unknown> | undefined) ?? {};
      const tool = TOOLS.find((t) => t.name === toolName);
      if (!tool) return jsonRpcError(body.id, -32602, `Unknown tool: ${String(toolName)}`);
      try {
        const text = await tool.handler(toolArgs);
        return jsonRpcResult(body.id, { content: [{ type: 'text', text }] });
      } catch (err) {
        return jsonRpcResult(body.id, {
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        });
      }
    }

    default:
      return jsonRpcError(body.id, -32601, `Method not found: ${body.method}`);
  }
}
