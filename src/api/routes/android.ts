import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { androidRuntimeProvider } from '../../android/provider.js';
import type { AndroidControlAction } from '../../android/types.js';
import type { GatewayVariables } from '../../auth/middleware.js';
import { requireAuth } from '../../auth/middleware.js';
import { config } from '../../config.js';
import { decryptJson, encryptJson } from '../../crypto.js';
import { prisma } from '../../db/prisma.js';
import { id } from '../../ids.js';
import { body, idempotencyKey } from '../helpers.js';

const app = new Hono<{ Variables: GatewayVariables }>();

const createSchema = z.object({
  display_name: z.string().trim().min(1).max(100).default('WhatsApp Android'),
  account_id: z.string().min(1).optional(),
  proxy_url: z.string().url().refine(
    (value) => ['http:', 'https:'].includes(new URL(value).protocol),
    'proxy_url must use http:// or https://',
  ).optional(),
});

const selectorStrategySchema = z.enum([
  'accessibility id',
  'id',
  '-android uiautomator',
  'xpath',
]);

export const androidActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('whatsapp.launch') }),
  z.object({
    type: z.literal('whatsapp.compose'),
    phone_number: z.string().min(7).max(32),
    text: z.string().max(4000).optional(),
  }),
  z.object({
    type: z.literal('whatsapp.open_chat'),
    phone_number: z.string().min(7).max(32),
    text: z.string().max(4000).optional(),
  }),
  z.object({
    type: z.literal('whatsapp.send_text'),
    phone_number: z.string().min(7).max(32),
    text: z.string().min(1).max(4000),
    timeout_ms: z.number().int().min(1000).max(60_000).optional(),
  }),
  z.object({ type: z.literal('whatsapp.force_stop') }),
  z.object({
    type: z.literal('apps.list'),
    query: z.string().max(200).optional(),
  }),
  z.object({
    type: z.literal('app.open'),
    package_name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/),
  }),
  z.object({
    type: z.literal('url.open'),
    url: z.string().url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol)),
  }),
  z.object({ type: z.literal('notifications.list') }),
  z.object({ type: z.literal('notifications.open_shade') }),
  z.object({ type: z.literal('network.egress') }),
  z.object({ type: z.literal('screen.screenshot') }),
  z.object({ type: z.literal('ui.dump') }),
  z.object({ type: z.literal('ui.source') }),
  z.object({
    type: z.literal('ui.find'),
    using: selectorStrategySchema,
    value: z.string().min(1).max(4000),
  }),
  z.object({
    type: z.literal('ui.find_all'),
    using: selectorStrategySchema,
    value: z.string().min(1).max(4000),
  }),
  z.object({
    type: z.literal('ui.click'),
    using: selectorStrategySchema,
    value: z.string().min(1).max(4000),
  }),
  z.object({
    type: z.literal('ui.set_value'),
    using: selectorStrategySchema,
    value: z.string().min(1).max(4000),
    text: z.string().min(1).max(4000),
  }),
  z.object({
    type: z.literal('input.tap'),
    x: z.number().int().min(0).max(10_000),
    y: z.number().int().min(0).max(10_000),
  }),
  z.object({
    type: z.literal('input.long_press'),
    x: z.number().int().min(0).max(10_000),
    y: z.number().int().min(0).max(10_000),
    duration_ms: z.number().int().min(250).max(10_000).optional(),
  }),
  z.object({
    type: z.literal('input.swipe'),
    x1: z.number().int().min(0).max(10_000),
    y1: z.number().int().min(0).max(10_000),
    x2: z.number().int().min(0).max(10_000),
    y2: z.number().int().min(0).max(10_000),
    duration_ms: z.number().int().min(0).max(10_000).optional(),
  }),
  z.object({ type: z.literal('input.text'), text: z.string().min(1).max(1000) }),
  z.object({
    type: z.literal('input.keyevent'),
    keycode: z.string().regex(/^(?:KEYCODE_[A-Z0-9_]+|[0-9]{1,3})$/),
  }),
  z.object({ type: z.literal('clipboard.set'), text: z.string().max(20_000) }),
  z.object({ type: z.literal('clipboard.paste') }),
  z.object({ type: z.literal('share.text'), text: z.string().min(1).max(20_000) }),
]);

type AndroidInstanceRecord = Awaited<ReturnType<typeof prisma.androidInstance.findFirstOrThrow>>;

function publicInstance(instance: AndroidInstanceRecord) {
  return {
    id: instance.id,
    account_id: instance.accountId,
    display_name: instance.displayName,
    provider: instance.provider,
    provider_instance_id: instance.providerInstanceId,
    source_provider_instance_id: instance.sourceProviderInstanceId,
    snapshot_id: instance.snapshotId,
    status: instance.status,
    novnc_url: instance.novncUrl,
    android_version: instance.androidVersion,
    whatsapp_version: instance.whatsappVersion,
    last_health_at: instance.lastHealthAt,
    last_error: instance.lastError,
    metadata: instance.metadata,
    created_at: instance.createdAt,
    updated_at: instance.updatedAt,
    deleted_at: instance.deletedAt,
  };
}

async function instanceFor(tenantId: string, instanceId: string): Promise<AndroidInstanceRecord> {
  const instance = await prisma.androidInstance.findFirst({
    where: { id: instanceId, tenantId, deletedAt: null },
  });
  if (!instance) throw new HTTPException(404, { message: 'Android instance not found' });
  return instance;
}

async function audit(
  actor: GatewayVariables['actor'],
  action: string,
  instanceId: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      id: id('aud'),
      tenantId: actor.tenantId,
      actorType: actor.type,
      actorId: actor.id,
      action,
      resourceType: 'android_instance',
      resourceId: instanceId,
      data: data as Prisma.InputJsonValue,
    },
  });
}

async function providerCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new HTTPException(502, {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

app.get('/v1/android/instances', requireAuth({ resource: 'android', action: 'read' }), async (context) => {
  const actor = context.get('actor');
  const instances = await prisma.androidInstance.findMany({
    where: { tenantId: actor.tenantId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  return context.json({ data: instances.map(publicInstance) });
});

app.post('/v1/android/instances', requireAuth({ resource: 'android', action: 'write' }), async (context) => {
  context.header('Cache-Control', 'no-store');
  const actor = context.get('actor');
  const input = await body(context, createSchema);
  const requestKey = idempotencyKey(context);

  if (input.account_id) {
    const account = await prisma.whatsAppAccount.findFirst({
      where: { id: input.account_id, tenantId: actor.tenantId },
      select: { id: true },
    });
    if (!account) throw new HTTPException(404, { message: 'WhatsApp account not found' });
  }

  if (requestKey) {
    const existing = await prisma.androidInstance.findFirst({
      where: { tenantId: actor.tenantId, idempotencyKey: requestKey },
    });
    if (existing) return context.json(publicInstance(existing), 200);
  }

  const instanceId = id('ari');
  const instance = await prisma.androidInstance.create({
    data: {
      id: instanceId,
      tenantId: actor.tenantId,
      accountId: input.account_id ?? null,
      displayName: input.display_name,
      provider: 'platinum',
      sourceProviderInstanceId: config.PLATINUM_ANDROID_SOURCE_SANDBOX_ID ?? 'unconfigured',
      snapshotId: config.PLATINUM_ANDROID_SNAPSHOT_ID ?? 'unconfigured',
      idempotencyKey: requestKey ?? null,
    },
  });

  try {
    const runtime = await providerCall(() => androidRuntimeProvider().provision({
      name: `wa-android-${instance.id.slice(-12)}`,
      ...(input.proxy_url ? { proxyUrl: input.proxy_url } : {}),
    }));
    const ready = await prisma.androidInstance.update({
      where: { id: instance.id },
      data: {
        providerInstanceId: runtime.providerInstanceId,
        sourceProviderInstanceId: runtime.sourceProviderInstanceId,
        snapshotId: runtime.snapshotId,
        status: runtime.state,
        encryptedControlUrl: encryptJson(runtime.controlUrl),
        encryptedControlToken: encryptJson(runtime.controlToken),
        novncUrl: runtime.novncUrl,
        encryptedVncPassword: encryptJson(runtime.vncPassword),
        encryptedProxyUrl: input.proxy_url ? encryptJson(input.proxy_url) : null,
        androidVersion: runtime.health.android_version ?? null,
        whatsappVersion: runtime.health.whatsapp_version ?? null,
        lastHealthAt: new Date(),
        lastError: runtime.health.error ?? null,
        metadata: runtime.metadata as Prisma.InputJsonValue,
      },
    });
    await audit(actor, 'android_instance.create', ready.id, {
      provider: ready.provider,
      provider_instance_id: ready.providerInstanceId,
      snapshot_id: ready.snapshotId,
    });
    return context.json({
      ...publicInstance(ready),
      credentials: {
        control_url: runtime.controlUrl,
        control_token: runtime.controlToken,
        novnc_url: runtime.novncUrl,
        vnc_password: runtime.vncPassword,
      },
    }, 201);
  } catch (error) {
    await prisma.androidInstance.update({
      where: { id: instance.id },
      data: {
        status: 'failed',
        lastError: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
});

app.get('/v1/android/instances/:instanceId', requireAuth({ resource: 'android', action: 'read' }), async (context) => {
  return context.json(publicInstance(await instanceFor(context.get('actor').tenantId, context.req.param('instanceId'))));
});

app.get('/v1/android/instances/:instanceId/status', requireAuth({ resource: 'android', action: 'read' }), async (context) => {
  context.header('Cache-Control', 'no-store');
  const actor = context.get('actor');
  const instance = await instanceFor(actor.tenantId, context.req.param('instanceId'));
  if (!instance.providerInstanceId) return context.json(publicInstance(instance));
  const health = await providerCall(() => androidRuntimeProvider().inspect(instance.providerInstanceId!));
  const updated = await prisma.androidInstance.update({
    where: { id: instance.id },
    data: {
      status: health.provider_state === 'running' && health.android_booted ? 'running' : health.provider_state,
      androidVersion: health.android_version ?? null,
      whatsappVersion: health.whatsapp_version ?? null,
      lastHealthAt: new Date(),
      lastError: health.error ?? null,
    },
  });
  return context.json({ ...publicInstance(updated), health });
});

app.post('/v1/android/instances/:instanceId/actions', requireAuth({ resource: 'android', action: 'control' }), async (context) => {
  context.header('Cache-Control', 'no-store');
  const actor = context.get('actor');
  const instance = await instanceFor(actor.tenantId, context.req.param('instanceId'));
  if (!instance.providerInstanceId) throw new HTTPException(409, { message: 'Android instance is not ready' });
  const action = await body(context, androidActionSchema) as AndroidControlAction;
  const result = await providerCall(() => androidRuntimeProvider().action(instance.providerInstanceId!, action));
  await audit(actor, 'android_instance.control', instance.id, { action: action.type });
  return context.json({ instance_id: instance.id, action: action.type, result });
});

app.post('/v1/android/instances/:instanceId/start', requireAuth({ resource: 'android', action: 'write' }), async (context) => {
  const actor = context.get('actor');
  const instance = await instanceFor(actor.tenantId, context.req.param('instanceId'));
  if (!instance.providerInstanceId) throw new HTTPException(409, { message: 'Android instance is not ready' });
  const health = await providerCall(() => androidRuntimeProvider().start(instance.providerInstanceId!));
  const updated = await prisma.androidInstance.update({
    where: { id: instance.id },
    data: {
      status: health.android_booted ? 'running' : health.provider_state,
      lastHealthAt: new Date(),
      lastError: health.error ?? null,
    },
  });
  await audit(actor, 'android_instance.start', instance.id);
  return context.json({ ...publicInstance(updated), health });
});

app.post('/v1/android/instances/:instanceId/upgrade', requireAuth({ resource: 'android', action: 'write' }), async (context) => {
  const actor = context.get('actor');
  const instance = await instanceFor(actor.tenantId, context.req.param('instanceId'));
  if (!instance.providerInstanceId) throw new HTTPException(409, { message: 'Android instance is not ready' });
  const credentials = decryptAndroidInstanceCredentials(instance);
  if (!credentials.control_token || !credentials.vnc_password) {
    throw new HTTPException(409, { message: 'Android instance credentials are unavailable' });
  }
  const health = await providerCall(() => androidRuntimeProvider().upgrade(instance.providerInstanceId!, {
    controlToken: credentials.control_token!,
    vncPassword: credentials.vnc_password!,
    ...(credentials.proxy_url ? { proxyUrl: credentials.proxy_url } : {}),
  }));
  const updated = await prisma.androidInstance.update({
    where: { id: instance.id },
    data: {
      status: health.android_booted ? 'running' : health.provider_state,
      androidVersion: health.android_version ?? null,
      whatsappVersion: health.whatsapp_version ?? null,
      lastHealthAt: new Date(),
      lastError: health.error ?? null,
    },
  });
  await audit(actor, 'android_instance.upgrade', instance.id, {
    provider_instance_id: instance.providerInstanceId,
    agent_version: health.agent_version,
  });
  return context.json({ ...publicInstance(updated), health });
});

app.post('/v1/android/instances/:instanceId/stop', requireAuth({ resource: 'android', action: 'write' }), async (context) => {
  const actor = context.get('actor');
  const instance = await instanceFor(actor.tenantId, context.req.param('instanceId'));
  if (!instance.providerInstanceId) throw new HTTPException(409, { message: 'Android instance is not ready' });
  await providerCall(() => androidRuntimeProvider().stop(instance.providerInstanceId!));
  const updated = await prisma.androidInstance.update({
    where: { id: instance.id },
    data: { status: 'stopped', lastError: null },
  });
  await audit(actor, 'android_instance.stop', instance.id);
  return context.json(publicInstance(updated));
});

app.delete('/v1/android/instances/:instanceId', requireAuth({ resource: 'android', action: 'write' }), async (context) => {
  const actor = context.get('actor');
  const instance = await instanceFor(actor.tenantId, context.req.param('instanceId'));
  if (instance.providerInstanceId) {
    await providerCall(() => androidRuntimeProvider().destroy(instance.providerInstanceId!));
  }
  await prisma.androidInstance.update({
    where: { id: instance.id },
    data: {
      status: 'deleted',
      deletedAt: new Date(),
      encryptedControlUrl: null,
      encryptedControlToken: null,
      encryptedVncPassword: null,
      encryptedProxyUrl: null,
    },
  });
  await audit(actor, 'android_instance.delete', instance.id, {
    provider_instance_id: instance.providerInstanceId,
  });
  return context.body(null, 204);
});

// Kept private to this module today, but intentionally validates that encrypted
// records remain readable before a future credential-rotation endpoint is added.
export function decryptAndroidInstanceCredentials(instance: {
  encryptedControlUrl: string | null;
  encryptedControlToken: string | null;
  encryptedVncPassword: string | null;
  encryptedProxyUrl?: string | null;
}) {
  return {
    control_url: instance.encryptedControlUrl ? decryptJson<string>(instance.encryptedControlUrl) : null,
    control_token: instance.encryptedControlToken ? decryptJson<string>(instance.encryptedControlToken) : null,
    vnc_password: instance.encryptedVncPassword ? decryptJson<string>(instance.encryptedVncPassword) : null,
    proxy_url: instance.encryptedProxyUrl ? decryptJson<string>(instance.encryptedProxyUrl) : null,
  };
}

export const androidRoutes = app;
