# Kortix mobile and WhatsApp MCP

The gateway exposes an independent agent contract inspired by the useful
separation in agentic-phone projects: agents see semantic tools, while provider
and emulator details remain behind adapters. No OpenPhone-owned source,
manifest text, or Android framework patch is included.

## Architecture

```text
MCP client
└── Kortix tool registry
    ├── control-plane executor
    │   └── accounts, Android lifecycle, commands, events
    ├── WhatsApp executor
    │   └── normalized chats/messages/groups plus managed Baileys actions
    └── Android executor
        └── Platinum provider → authenticated guest agent → ADB/Appium
```

The semantic WhatsApp executor is the source of truth for synchronized
messages, chats, contacts, groups, receipts, and durable events. Native Android
is the primary device, enrollment surface, health anchor, notification bridge,
and escape hatch for workflows not represented by the companion API.

## Transports

Remote Streamable HTTP:

```text
POST /mcp
Authorization: Bearer wag_...
Accept: application/json, text/event-stream
Content-Type: application/json
```

The server is stateless and uses JSON responses. Every MCP request creates a
fresh server/transport pair. Tool calls are routed back through the ordinary
Hono application, so REST authorization, tenant isolation, account scoping,
validation, durable commands, idempotency, and audit behavior remain canonical.

Local stdio:

```bash
WHATSAPP_GATEWAY_URL=https://wag.kortix.cloud \
WHATSAPP_GATEWAY_API_KEY=wag_... \
wag-mcp
```

The registry is also available as JSON at `GET /v1/mcp/manifest`.

## Safety contract

Each tool declares:

- standard MCP read-only, destructive, idempotent, and open-world annotations;
- `kortix/confirmation`: `none`, `ask_before_action`, or `always`;
- `kortix/executor`: `android`, `whatsapp`, or `control-plane`;
- a strict Zod input schema.

All state-changing tools require the literal input `confirmed: true`. This does
not replace client-side confirmation UI; it prevents a client that ignored the
tool annotation from accidentally invoking the action without an explicit
acknowledgement.

Pairing QR data, phone-link codes, WhatsApp registration OTPs, proxy
credentials, Android controller credentials, and VNC passwords are deliberately
absent from the MCP surface.

## Provider independence

MCP tools never accept a Platinum token or sandbox command. The gateway owns the
provider adapter and exposes bounded actions only. A future Waydroid, physical
Android, or alternative emulator adapter can implement the same
`AndroidRuntimeProvider` interface without changing agent-facing tool names.

The enrolled Android identity is never cloned. New phones come only from the
pre-enrollment golden snapshot. Controller upgrades use
`POST /v1/android/instances/{instanceId}/upgrade`, which preserves Android and
WhatsApp userdata.

## Verification

The automated contract test connects an official MCP client and server through
the SDK's in-memory transport, lists every tool, calls a read operation, proves
write validation rejects a missing confirmation, and proves an accepted send
forwards the durable idempotency key.

Production acceptance additionally checks:

1. unauthenticated MCP initialization is rejected;
2. authenticated initialization and `tools/list` succeed;
3. a live `mobile_device_status` call reaches the retained Android;
4. a live `mobile_network_verify` call proves proxy attachment;
5. a semantic WhatsApp send and receive event complete after companion pairing.
