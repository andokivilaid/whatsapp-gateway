#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { remoteGatewayClient } from './mcp/client.js';
import { createGatewayMcpServer } from './mcp/server.js';

const baseUrl = process.env.WHATSAPP_GATEWAY_URL?.trim() || 'https://wag.kortix.cloud';
const apiKey = process.env.WHATSAPP_GATEWAY_API_KEY?.trim();

if (!apiKey) {
  process.stderr.write('WHATSAPP_GATEWAY_API_KEY is required.\n');
  process.exit(1);
}

const server = createGatewayMcpServer(remoteGatewayClient(baseUrl, apiKey));
await server.connect(new StdioServerTransport());
