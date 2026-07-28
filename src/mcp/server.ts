import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { GatewayApiError, type GatewayApiClient } from './client.js';
import { gatewayTools } from './tools.js';

function record(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return { data: value };
}

function imageResult(value: unknown): CallToolResult | null {
  const envelope = record(value);
  const result = record(envelope.result);
  if (result.mime_type !== 'image/png' || typeof result.data_base64 !== 'string') return null;
  return {
    content: [
      {
        type: 'image',
        data: result.data_base64,
        mimeType: 'image/png',
      },
      {
        type: 'text',
        text: JSON.stringify({
          instance_id: envelope.instance_id,
          action: envelope.action,
          mime_type: result.mime_type,
          bytes: Math.floor(result.data_base64.length * 3 / 4),
        }),
      },
    ],
    structuredContent: {
      instance_id: envelope.instance_id,
      action: envelope.action,
      result: {
        mime_type: result.mime_type,
        bytes: Math.floor(result.data_base64.length * 3 / 4),
      },
    },
  };
}

function success(value: unknown): CallToolResult {
  const image = imageResult(value);
  if (image) return image;
  const structuredContent = record(value);
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function failure(error: unknown): CallToolResult {
  const structuredContent = error instanceof GatewayApiError
    ? { error: 'gateway_request_failed', status: error.status, message: error.message, response: error.response }
    : { error: 'tool_execution_failed', message: error instanceof Error ? error.message : String(error) };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

export function createGatewayMcpServer(client: GatewayApiClient): McpServer {
  const server = new McpServer({
    name: 'kortix-mobile-whatsapp',
    version: '1.0.0',
  }, {
    capabilities: {
      tools: { listChanged: false },
    },
    instructions: [
      'Use semantic whatsapp_* tools for chats and messages whenever possible.',
      'Use mobile_* tools for enrollment, health, visible UI, and native-only workflows.',
      'Never expose API keys, proxy credentials, pairing QR data, pairing codes, or verification codes.',
      'State-changing tools require confirmed=true after the user authorizes the action.',
    ].join(' '),
  });

  for (const definition of gatewayTools) {
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        annotations: definition.annotations,
        _meta: {
          'kortix/confirmation': definition.confirmation,
          'kortix/executor': definition.executor,
        },
      },
      async (input) => {
        try {
          return success(await definition.execute(client, input));
        } catch (error) {
          return failure(error);
        }
      },
    );
  }
  return server;
}

export async function handleGatewayMcpRequest(request: Request, client: GatewayApiClient): Promise<Response> {
  const server = createGatewayMcpServer(client);
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
