import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { GatewayApiClient } from './client.js';
import { createGatewayMcpServer, handleGatewayMcpRequest } from './server.js';
import { gatewayToolManifest, gatewayTools } from './tools.js';

const open: Array<{ client: Client; server: ReturnType<typeof createGatewayMcpServer> }> = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map(async ({ client, server }) => {
    await client.close();
    await server.close();
  }));
});

async function harness() {
  const requests: Request[] = [];
  const gateway = new GatewayApiClient(async (request) => {
    requests.push(request);
    const path = new URL(request.url).pathname;
    if (path.endsWith('/messages')) {
      return Response.json({ command_id: 'cmd_test', status: 'completed', result: { message_id: 'wam_test' } });
    }
    return Response.json({ data: [{ id: 'wa_test', status: 'connected' }] });
  }, { authorization: 'Bearer wag_test' });
  const server = createGatewayMcpServer(gateway);
  const client = new Client({ name: 'gateway-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  open.push({ client, server });
  return { client, requests };
}

describe('Kortix mobile MCP server', () => {
  it('publishes one independent manifest with MCP safety metadata', async () => {
    const names = gatewayTools.map((definition) => definition.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(40);
    expect(names).toContain('mobile_screen_read');
    expect(names).toContain('mobile_whatsapp_send_text');
    expect(names).toContain('whatsapp_messages_search');
    expect(names).toContain('whatsapp_action_run');

    const manifest = gatewayToolManifest();
    expect(manifest.endpoint).toBe('/mcp');
    expect(manifest.tools).toHaveLength(names.length);
    expect(manifest.tools.find((entry) => entry.name === 'whatsapp_message_send')).toMatchObject({
      confirmation: 'always',
      executor: 'whatsapp',
    });
  });

  it('lists and calls read-only tools over a real MCP transport', async () => {
    const { client, requests } = await harness();
    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(gatewayTools.length);
    expect(listed.tools.find((entry) => entry.name === 'mobile_network_verify')?.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: true,
    });

    const result = await client.callTool({ name: 'whatsapp_accounts_list', arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ data: [{ id: 'wa_test', status: 'connected' }] });
    expect(requests.at(-1)?.headers.get('authorization')).toBe('Bearer wag_test');
    expect(new URL(requests.at(-1)!.url).pathname).toBe('/v1/accounts');
  });

  it('requires explicit confirmation and forwards durable idempotency keys', async () => {
    const { client, requests } = await harness();
    const rejected = await client.callTool({
      name: 'whatsapp_message_send',
      arguments: { account_id: 'wa_test', to: '15551234567', text: 'hello' },
    });
    expect(rejected.isError).toBe(true);
    expect(requests).toHaveLength(0);

    const accepted = await client.callTool({
      name: 'whatsapp_message_send',
      arguments: {
        account_id: 'wa_test',
        to: '15551234567',
        text: 'hello',
        idempotency_key: 'mcp-send-test-1',
        confirmed: true,
      },
    });
    expect(accepted.isError).not.toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get('idempotency-key')).toBe('mcp-send-test-1');
    expect(await requests[0]?.json()).toEqual({ to: '15551234567', text: 'hello' });
  });

  it('serves initialization and tool discovery over independent stateless HTTP requests', async () => {
    const gateway = new GatewayApiClient(async () => Response.json({ data: [] }), {});
    const headers = {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const initialized = await handleGatewayMcpRequest(new Request('https://gateway.test/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'http-test', version: '1.0.0' },
        },
      }),
    }), gateway);
    expect(initialized.status).toBe(200);
    expect(await initialized.json()).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-11-25',
        serverInfo: { name: 'kortix-mobile-whatsapp' },
      },
    });

    const listed = await handleGatewayMcpRequest(new Request('https://gateway.test/mcp', {
      method: 'POST',
      headers: { ...headers, 'mcp-protocol-version': '2025-11-25' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }),
    }), gateway);
    expect(listed.status).toBe(200);
    const body = await listed.json() as { result?: { tools?: unknown[] } };
    expect(body.result?.tools).toHaveLength(gatewayTools.length);
  });
});
