import { z } from 'zod';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { GatewayApiClient } from './client.js';

export type ToolConfirmation = 'none' | 'ask_before_action' | 'always';
export type ToolExecutor = 'android' | 'whatsapp' | 'control-plane';

export type GatewayToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodObject<any>;
  annotations: ToolAnnotations;
  confirmation: ToolConfirmation;
  executor: ToolExecutor;
  execute: (client: GatewayApiClient, input: any) => Promise<unknown>;
};

const accountId = z.string().min(1).describe('WhatsApp Gateway account id beginning with wa_.');
const instanceId = z.string().min(1).describe('Persistent Android runtime id beginning with ari_.');
const confirmed = z.literal(true).describe('Required acknowledgement that the user authorized this external action.');
const idempotencyKey = z.string().min(1).max(200).optional()
  .describe('Stable caller-generated retry key. Reuse it only for the exact same requested action.');
const selector = {
  using: z.enum(['accessibility id', 'id', '-android uiautomator', 'xpath']),
  value: z.string().min(1).max(4000),
};

function pathPart(value: string): string {
  return encodeURIComponent(value);
}

function queryText(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function readOnly(): ToolAnnotations {
  return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
}

function stateful(options: { destructive?: boolean; idempotent?: boolean; openWorld?: boolean } = {}): ToolAnnotations {
  return {
    readOnlyHint: false,
    destructiveHint: options.destructive ?? false,
    idempotentHint: options.idempotent ?? false,
    openWorldHint: options.openWorld ?? false,
  };
}

async function androidAction(client: GatewayApiClient, id: string, action: Record<string, unknown>): Promise<unknown> {
  return client.request('POST', `/v1/android/instances/${pathPart(id)}/actions`, { body: action });
}

function tool(
  definition: Omit<GatewayToolDefinition, 'executor'> & { executor?: ToolExecutor },
): GatewayToolDefinition {
  return { executor: definition.executor ?? 'android', ...definition };
}

export const gatewayTools: GatewayToolDefinition[] = [
  tool({
    name: 'mobile_devices_list',
    title: 'List Android phones',
    description: 'List persistent Android runtimes accessible to this credential. Secrets and VNC credentials are omitted.',
    inputSchema: z.object({}),
    annotations: readOnly(),
    confirmation: 'none',
    executor: 'control-plane',
    execute: (client) => client.request('GET', '/v1/android/instances'),
  }),
  tool({
    name: 'mobile_device_status',
    title: 'Inspect Android phone health',
    description: 'Refresh the Platinum sandbox, Android boot, ADB, native automation, and installed WhatsApp health for one phone.',
    inputSchema: z.object({ instance_id: instanceId }),
    annotations: readOnly(),
    confirmation: 'none',
    executor: 'control-plane',
    execute: (client, input) => client.request('GET', `/v1/android/instances/${pathPart(input.instance_id)}/status`),
  }),
  tool({
    name: 'mobile_device_start',
    title: 'Start Android phone',
    description: 'Start the persistent Platinum sandbox and wait until Android and the native controller are ready.',
    inputSchema: z.object({ instance_id: instanceId, confirmed }),
    annotations: stateful({ idempotent: true }),
    confirmation: 'ask_before_action',
    executor: 'control-plane',
    execute: (client, input) => client.request('POST', `/v1/android/instances/${pathPart(input.instance_id)}/start`, { body: {} }),
  }),
  tool({
    name: 'mobile_device_stop',
    title: 'Stop Android phone',
    description: 'Gracefully power down Android and stop its persistent Platinum sandbox. This does not delete the phone.',
    inputSchema: z.object({ instance_id: instanceId, confirmed }),
    annotations: stateful({ destructive: true, idempotent: true }),
    confirmation: 'always',
    executor: 'control-plane',
    execute: (client, input) => client.request('POST', `/v1/android/instances/${pathPart(input.instance_id)}/stop`, { body: {} }),
  }),
  tool({
    name: 'mobile_device_upgrade',
    title: 'Upgrade Android controller',
    description: 'Upgrade and verify the bounded in-guest controller without changing Android userdata, WhatsApp enrollment, or credentials.',
    inputSchema: z.object({ instance_id: instanceId, confirmed }),
    annotations: stateful({ idempotent: true }),
    confirmation: 'ask_before_action',
    executor: 'control-plane',
    execute: (client, input) => client.request('POST', `/v1/android/instances/${pathPart(input.instance_id)}/upgrade`, { body: {} }),
  }),
  tool({
    name: 'mobile_screen_read',
    title: 'Read Android screen hierarchy',
    description: 'Return the current native Android UI hierarchy from UiAutomator2 for grounded element inspection.',
    inputSchema: z.object({ instance_id: instanceId }),
    annotations: readOnly(),
    confirmation: 'none',
    execute: (client, input) => androidAction(client, input.instance_id, { type: 'ui.source' }),
  }),
  tool({
    name: 'mobile_screen_capture',
    title: 'Capture Android screenshot',
    description: 'Capture the current Android display as a PNG image.',
    inputSchema: z.object({ instance_id: instanceId }),
    annotations: readOnly(),
    confirmation: 'none',
    execute: (client, input) => androidAction(client, input.instance_id, { type: 'screen.screenshot' }),
  }),
  tool({
    name: 'mobile_apps_search',
    title: 'Search installed Android apps',
    description: 'List launchable Android packages and optionally filter them by package or activity text.',
    inputSchema: z.object({ instance_id: instanceId, query: z.string().max(200).optional() }),
    annotations: readOnly(),
    confirmation: 'none',
    execute: (client, input) => androidAction(client, input.instance_id, { type: 'apps.list', query: queryText(input.query) }),
  }),
  tool({
    name: 'mobile_app_open',
    title: 'Open Android app',
    description: 'Launch an installed Android application by package name.',
    inputSchema: z.object({
      instance_id: instanceId,
      package_name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/),
      confirmed,
    }),
    annotations: stateful({ idempotent: true }),
    confirmation: 'ask_before_action',
    execute: (client, input) => androidAction(client, input.instance_id, {
      type: 'app.open', package_name: input.package_name,
    }),
  }),
  tool({
    name: 'mobile_url_open',
    title: 'Open URL on Android',
    description: 'Open an HTTP or HTTPS URL through Android intent resolution.',
    inputSchema: z.object({ instance_id: instanceId, url: z.string().url(), confirmed }),
    annotations: stateful({ openWorld: true }),
    confirmation: 'ask_before_action',
    execute: (client, input) => androidAction(client, input.instance_id, { type: 'url.open', url: input.url }),
  }),
  tool({
    name: 'mobile_notifications_list',
    title: 'List WhatsApp notifications',
    description: 'Read recent WhatsApp entries from Android notification history. This is a bounded buffer, not complete chat history.',
    inputSchema: z.object({ instance_id: instanceId }),
    annotations: readOnly(),
    confirmation: 'none',
    execute: (client, input) => androidAction(client, input.instance_id, { type: 'notifications.list' }),
  }),
  tool({
    name: 'mobile_notifications_open',
    title: 'Open notification shade',
    description: 'Expand the Android notification shade so the agent can inspect and act on visible notifications.',
    inputSchema: z.object({ instance_id: instanceId, confirmed }),
    annotations: stateful({ idempotent: true }),
    confirmation: 'ask_before_action',
    execute: (client, input) => androidAction(client, input.instance_id, { type: 'notifications.open_shade' }),
  }),
  tool({
    name: 'mobile_network_verify',
    title: 'Verify Android network egress',
    description: 'Verify that the emulator proxy flag is attached and compare direct versus configured proxy egress IPs without returning credentials.',
    inputSchema: z.object({ instance_id: instanceId }),
    annotations: { ...readOnly(), openWorldHint: true },
    confirmation: 'none',
    execute: (client, input) => androidAction(client, input.instance_id, { type: 'network.egress' }),
  }),
  tool({
    name: 'mobile_ui_find',
    title: 'Find Android element',
    description: 'Resolve one native UI element using a bounded UiAutomator2 selector.',
    inputSchema: z.object({ instance_id: instanceId, ...selector }),
    annotations: readOnly(),
    confirmation: 'none',
    execute: (client, input) => androidAction(client, input.instance_id, {
      type: 'ui.find', using: input.using, value: input.value,
    }),
  }),
  tool({
    name: 'mobile_ui_find_all',
    title: 'Find Android elements',
    description: 'Resolve all native UI elements matching a bounded UiAutomator2 selector.',
    inputSchema: z.object({ instance_id: instanceId, ...selector }),
    annotations: readOnly(),
    confirmation: 'none',
    execute: (client, input) => androidAction(client, input.instance_id, {
      type: 'ui.find_all', using: input.using, value: input.value,
    }),
  }),
  tool({
    name: 'mobile_ui_click',
    title: 'Click Android element',
    description: 'Click one enabled native Android element selected by accessibility id, resource id, UiSelector, or XPath.',
    inputSchema: z.object({ instance_id: instanceId, ...selector, confirmed }),
    annotations: stateful(),
    confirmation: 'ask_before_action',
    execute: (client, input) => androidAction(client, input.instance_id, {
      type: 'ui.click', using: input.using, value: input.value,
    }),
  }),
  tool({
    name: 'mobile_ui_set_value',
    title: 'Set Android field value',
    description: 'Set the value of one selected native Android input field.',
    inputSchema: z.object({ instance_id: instanceId, ...selector, text: z.string().min(1).max(4000), confirmed }),
    annotations: stateful(),
    confirmation: 'ask_before_action',
    execute: (client, input) => androidAction(client, input.instance_id, {
      type: 'ui.set_value', using: input.using, value: input.value, text: input.text,
    }),
  }),
  tool({
    name: 'mobile_ui_tap',
    title: 'Tap Android coordinates',
    description: 'Tap absolute coordinates on the Android display. Prefer element selectors when available.',
    inputSchema: z.object({
      instance_id: instanceId,
      x: z.number().int().min(0).max(10_000),
      y: z.number().int().min(0).max(10_000),
      confirmed,
    }),
    annotations: stateful(),
    confirmation: 'ask_before_action',
    execute: (client, input) => androidAction(client, input.instance_id, { type: 'input.tap', x: input.x, y: input.y }),
  }),
  tool({
    name: 'mobile_ui_long_press',
    title: 'Long-press Android coordinates',
    description: 'Long-press absolute coordinates for a bounded duration.',
    inputSchema: z.object({
      instance_id: instanceId,
      x: z.number().int().min(0).max(10_000),
      y: z.number().int().min(0).max(10_000),
      duration_ms: z.number().int().min(250).max(10_000).default(800),
      confirmed,
    }),
    annotations: stateful(),
    confirmation: 'ask_before_action',
    execute: (client, input) => androidAction(client, input.instance_id, {
      type: 'input.long_press', x: input.x, y: input.y, duration_ms: input.duration_ms,
    }),
  }),
  tool({
    name: 'mobile_ui_swipe',
    title: 'Swipe Android screen',
    description: 'Swipe between two absolute Android display coordinates.',
    inputSchema: z.object({
      instance_id: instanceId,
      x1: z.number().int().min(0).max(10_000),
      y1: z.number().int().min(0).max(10_000),
      x2: z.number().int().min(0).max(10_000),
      y2: z.number().int().min(0).max(10_000),
      duration_ms: z.number().int().min(0).max(10_000).default(300),
      confirmed,
    }),
    annotations: stateful(),
    confirmation: 'ask_before_action',
    execute: (client, input) => androidAction(client, input.instance_id, {
      type: 'input.swipe',
      x1: input.x1,
      y1: input.y1,
      x2: input.x2,
      y2: input.y2,
      duration_ms: input.duration_ms,
    }),
  }),
  tool({
    name: 'mobile_ui_type',
    title: 'Type on Android',
    description: 'Type bounded text into the currently focused Android input field.',
    inputSchema: z.object({ instance_id: instanceId, text: z.string().min(1).max(1000), confirmed }),
    annotations: stateful(),
    confirmation: 'ask_before_action',
    execute: (client, input) => androidAction(client, input.instance_id, { type: 'input.text', text: input.text }),
  }),
  tool({
    name: 'mobile_input_key',
    title: 'Press Android key',
    description: 'Press a supported Android navigation, IME, or hardware key code.',
    inputSchema: z.object({
      instance_id: instanceId,
      keycode: z.string().regex(/^(?:KEYCODE_[A-Z0-9_]+|[0-9]{1,3})$/),
      confirmed,
    }),
    annotations: stateful(),
    confirmation: 'ask_before_action',
    execute: (client, input) => androidAction(client, input.instance_id, {
      type: 'input.keyevent', keycode: input.keycode,
    }),
  }),
  tool({
    name: 'mobile_clipboard_set',
    title: 'Set Android clipboard',
    description: 'Replace Android clipboard text using the authenticated native automation session.',
    inputSchema: z.object({ instance_id: instanceId, text: z.string().max(20_000), confirmed }),
    annotations: stateful({ idempotent: true }),
    confirmation: 'ask_before_action',
    execute: (client, input) => androidAction(client, input.instance_id, { type: 'clipboard.set', text: input.text }),
  }),
  tool({
    name: 'mobile_clipboard_paste',
    title: 'Paste Android clipboard',
    description: 'Paste the current Android clipboard into the focused field.',
    inputSchema: z.object({ instance_id: instanceId, confirmed }),
    annotations: stateful(),
    confirmation: 'ask_before_action',
    execute: (client, input) => androidAction(client, input.instance_id, { type: 'clipboard.paste' }),
  }),
  tool({
    name: 'mobile_share_text',
    title: 'Share text on Android',
    description: 'Open Android’s mediated text share flow. The agent must still select and confirm the destination.',
    inputSchema: z.object({ instance_id: instanceId, text: z.string().min(1).max(20_000), confirmed }),
    annotations: stateful({ openWorld: true }),
    confirmation: 'always',
    execute: (client, input) => androidAction(client, input.instance_id, { type: 'share.text', text: input.text }),
  }),
  tool({
    name: 'mobile_whatsapp_launch',
    title: 'Launch native WhatsApp',
    description: 'Bring the installed native WhatsApp Android application to the foreground.',
    inputSchema: z.object({ instance_id: instanceId, confirmed }),
    annotations: stateful({ idempotent: true }),
    confirmation: 'ask_before_action',
    execute: (client, input) => androidAction(client, input.instance_id, { type: 'whatsapp.launch' }),
  }),
  tool({
    name: 'mobile_whatsapp_open_chat',
    title: 'Open native WhatsApp chat',
    description: 'Open a phone-number chat in native WhatsApp, optionally preparing text without sending it.',
    inputSchema: z.object({
      instance_id: instanceId,
      phone_number: z.string().min(7).max(32),
      text: z.string().max(4000).optional(),
      confirmed,
    }),
    annotations: stateful({ openWorld: true }),
    confirmation: 'ask_before_action',
    execute: (client, input) => androidAction(client, input.instance_id, {
      type: 'whatsapp.open_chat', phone_number: input.phone_number, text: input.text,
    }),
  }),
  tool({
    name: 'mobile_whatsapp_send_text',
    title: 'Send through native WhatsApp',
    description: 'Open the real Android WhatsApp chat and click its native send button. Use the semantic WhatsApp tool when possible.',
    inputSchema: z.object({
      instance_id: instanceId,
      phone_number: z.string().min(7).max(32),
      text: z.string().min(1).max(4000),
      timeout_ms: z.number().int().min(1000).max(60_000).optional(),
      confirmed,
    }),
    annotations: stateful({ openWorld: true }),
    confirmation: 'always',
    execute: (client, input) => androidAction(client, input.instance_id, {
      type: 'whatsapp.send_text',
      phone_number: input.phone_number,
      text: input.text,
      timeout_ms: input.timeout_ms,
    }),
  }),
  tool({
    name: 'whatsapp_accounts_list',
    title: 'List WhatsApp connections',
    description: 'List normalized WhatsApp API connections visible to this credential.',
    inputSchema: z.object({}),
    annotations: readOnly(),
    confirmation: 'none',
    executor: 'whatsapp',
    execute: (client) => client.request('GET', '/v1/accounts'),
  }),
  tool({
    name: 'whatsapp_account_status',
    title: 'Inspect WhatsApp connection',
    description: 'Read connection, reconnect, linked-device, and proxy status without exposing pairing credentials.',
    inputSchema: z.object({ account_id: accountId }),
    annotations: readOnly(),
    confirmation: 'none',
    executor: 'whatsapp',
    execute: (client, input) => client.request('GET', `/v1/accounts/${pathPart(input.account_id)}/status`),
  }),
  tool({
    name: 'whatsapp_chats_search',
    title: 'Search WhatsApp chats',
    description: 'List synchronized chats with optional name/JID, unread, and archived filters.',
    inputSchema: z.object({
      account_id: accountId,
      query: z.string().max(300).optional(),
      unread: z.boolean().optional(),
      archived: z.boolean().optional(),
    }),
    annotations: readOnly(),
    confirmation: 'none',
    executor: 'whatsapp',
    execute: (client, input) => client.request('GET', `/v1/accounts/${pathPart(input.account_id)}/chats`, {
      query: { q: queryText(input.query), unread: input.unread, archived: input.archived },
    }),
  }),
  tool({
    name: 'whatsapp_contacts_search',
    title: 'Search WhatsApp contacts',
    description: 'Search synchronized WhatsApp contacts by name, phone number, or JID.',
    inputSchema: z.object({ account_id: accountId, query: z.string().max(300).optional() }),
    annotations: readOnly(),
    confirmation: 'none',
    executor: 'whatsapp',
    execute: (client, input) => client.request('GET', `/v1/accounts/${pathPart(input.account_id)}/contacts`, {
      query: { q: queryText(input.query) },
    }),
  }),
  tool({
    name: 'whatsapp_messages_search',
    title: 'Search WhatsApp messages',
    description: 'Search durable synchronized messages using chat, text, direction, type, sender, unread, and time filters.',
    inputSchema: z.object({
      account_id: accountId,
      chat_jid: z.string().max(200).optional(),
      query: z.string().max(1000).optional(),
      direction: z.enum(['inbound', 'outbound']).optional(),
      type: z.string().max(100).optional(),
      sender_jid: z.string().max(200).optional(),
      unread: z.boolean().optional(),
      since: z.string().datetime().optional(),
      before: z.string().datetime().optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }),
    annotations: readOnly(),
    confirmation: 'none',
    executor: 'whatsapp',
    execute: (client, input) => client.request('GET', `/v1/accounts/${pathPart(input.account_id)}/messages`, {
      query: {
        chat_jid: input.chat_jid,
        q: queryText(input.query),
        direction: input.direction,
        type: input.type,
        sender_jid: input.sender_jid,
        unread: input.unread,
        since: input.since,
        before: input.before,
        limit: input.limit,
      },
    }),
  }),
  tool({
    name: 'whatsapp_message_send',
    title: 'Send WhatsApp message',
    description: 'Durably send text or supported Baileys content through the linked WhatsApp connection.',
    inputSchema: z.object({
      account_id: accountId,
      to: z.string().min(3),
      text: z.string().max(65_000).optional(),
      content: z.record(z.string(), z.unknown()).optional(),
      idempotency_key: idempotencyKey,
      confirmed,
    }).refine((value) => value.text !== undefined || value.content !== undefined, 'text or content is required'),
    annotations: stateful({ openWorld: true }),
    confirmation: 'always',
    executor: 'whatsapp',
    execute: (client, input) => client.request('POST', `/v1/accounts/${pathPart(input.account_id)}/messages`, {
      headers: { 'idempotency-key': input.idempotency_key },
      body: { to: input.to, text: input.text, content: input.content },
    }),
  }),
  tool({
    name: 'whatsapp_message_react',
    title: 'React to WhatsApp message',
    description: 'Add or remove an emoji reaction on a stored WhatsApp message.',
    inputSchema: z.object({
      account_id: accountId,
      message_id: z.string().min(1),
      emoji: z.string().max(16),
      idempotency_key: idempotencyKey,
      confirmed,
    }),
    annotations: stateful({ idempotent: true, openWorld: true }),
    confirmation: 'always',
    executor: 'whatsapp',
    execute: (client, input) => client.request(
      'POST',
      `/v1/accounts/${pathPart(input.account_id)}/messages/${pathPart(input.message_id)}/reaction`,
      { headers: { 'idempotency-key': input.idempotency_key }, body: { emoji: input.emoji } },
    ),
  }),
  tool({
    name: 'whatsapp_message_mark_read',
    title: 'Mark WhatsApp message read',
    description: 'Mark a synchronized WhatsApp message as read.',
    inputSchema: z.object({
      account_id: accountId,
      message_id: z.string().min(1),
      idempotency_key: idempotencyKey,
      confirmed,
    }),
    annotations: stateful({ idempotent: true, openWorld: true }),
    confirmation: 'ask_before_action',
    executor: 'whatsapp',
    execute: (client, input) => client.request(
      'POST',
      `/v1/accounts/${pathPart(input.account_id)}/messages/${pathPart(input.message_id)}/read`,
      { headers: { 'idempotency-key': input.idempotency_key }, body: {} },
    ),
  }),
  tool({
    name: 'whatsapp_chat_update',
    title: 'Update WhatsApp chat',
    description: 'Archive, pin, mute, or change read state for one WhatsApp chat.',
    inputSchema: z.object({
      account_id: accountId,
      chat_jid: z.string().min(1),
      archived: z.boolean().optional(),
      pinned: z.boolean().optional(),
      muted: z.boolean().optional(),
      mute_seconds: z.number().int().positive().optional(),
      read: z.boolean().optional(),
      idempotency_key: idempotencyKey,
      confirmed,
    }),
    annotations: stateful({ idempotent: true, openWorld: true }),
    confirmation: 'ask_before_action',
    executor: 'whatsapp',
    execute: (client, input) => client.request(
      'PATCH',
      `/v1/accounts/${pathPart(input.account_id)}/chats/${pathPart(input.chat_jid)}`,
      {
        headers: { 'idempotency-key': input.idempotency_key },
        body: {
          archived: input.archived,
          pinned: input.pinned,
          muted: input.muted,
          mute_seconds: input.mute_seconds,
          read: input.read,
        },
      },
    ),
  }),
  tool({
    name: 'whatsapp_groups_search',
    title: 'Search WhatsApp groups',
    description: 'Search synchronized WhatsApp groups by subject or JID.',
    inputSchema: z.object({ account_id: accountId, query: z.string().max(300).optional() }),
    annotations: readOnly(),
    confirmation: 'none',
    executor: 'whatsapp',
    execute: (client, input) => client.request('GET', `/v1/accounts/${pathPart(input.account_id)}/groups`, {
      query: { q: queryText(input.query) },
    }),
  }),
  tool({
    name: 'whatsapp_group_create',
    title: 'Create WhatsApp group',
    description: 'Create a WhatsApp group with an initial participant list.',
    inputSchema: z.object({
      account_id: accountId,
      subject: z.string().min(1).max(100),
      participants: z.array(z.string().min(3)).min(1),
      idempotency_key: idempotencyKey,
      confirmed,
    }),
    annotations: stateful({ openWorld: true }),
    confirmation: 'always',
    executor: 'whatsapp',
    execute: (client, input) => client.request('POST', `/v1/accounts/${pathPart(input.account_id)}/groups`, {
      headers: { 'idempotency-key': input.idempotency_key },
      body: { subject: input.subject, participants: input.participants },
    }),
  }),
  tool({
    name: 'whatsapp_group_update',
    title: 'Update WhatsApp group',
    description: 'Change a WhatsApp group subject or description.',
    inputSchema: z.object({
      account_id: accountId,
      group_id: z.string().min(1),
      subject: z.string().min(1).max(100).optional(),
      description: z.string().max(2048).optional(),
      idempotency_key: idempotencyKey,
      confirmed,
    }),
    annotations: stateful({ idempotent: true, openWorld: true }),
    confirmation: 'always',
    executor: 'whatsapp',
    execute: (client, input) => client.request(
      'PATCH',
      `/v1/accounts/${pathPart(input.account_id)}/groups/${pathPart(input.group_id)}`,
      {
        headers: { 'idempotency-key': input.idempotency_key },
        body: { subject: input.subject, description: input.description },
      },
    ),
  }),
  tool({
    name: 'whatsapp_group_participants',
    title: 'Manage WhatsApp group participants',
    description: 'Add, remove, promote, or demote participants in an existing WhatsApp group.',
    inputSchema: z.object({
      account_id: accountId,
      group_id: z.string().min(1),
      participants: z.array(z.string().min(3)).min(1),
      action: z.enum(['add', 'remove', 'promote', 'demote']),
      idempotency_key: idempotencyKey,
      confirmed,
    }),
    annotations: stateful({ openWorld: true }),
    confirmation: 'always',
    executor: 'whatsapp',
    execute: (client, input) => client.request(
      'POST',
      `/v1/accounts/${pathPart(input.account_id)}/groups/${pathPart(input.group_id)}/participants`,
      {
        headers: { 'idempotency-key': input.idempotency_key },
        body: { participants: input.participants, action: input.action },
      },
    ),
  }),
  tool({
    name: 'whatsapp_presence_update',
    title: 'Update WhatsApp presence',
    description: 'Broadcast available, unavailable, composing, recording, or paused presence.',
    inputSchema: z.object({
      account_id: accountId,
      state: z.enum(['available', 'unavailable', 'composing', 'recording', 'paused']),
      to: z.string().optional(),
      idempotency_key: idempotencyKey,
      confirmed,
    }),
    annotations: stateful({ openWorld: true }),
    confirmation: 'ask_before_action',
    executor: 'whatsapp',
    execute: (client, input) => client.request('POST', `/v1/accounts/${pathPart(input.account_id)}/presence`, {
      headers: { 'idempotency-key': input.idempotency_key },
      body: { state: input.state, to: input.to },
    }),
  }),
  tool({
    name: 'whatsapp_action_run',
    title: 'Run managed WhatsApp action',
    description: 'Execute one action from the gateway’s allowlisted Baileys registry. Use only when no dedicated semantic tool covers the operation.',
    inputSchema: z.object({
      account_id: accountId,
      action: z.string().min(1).max(120),
      args: z.array(z.unknown()).default([]),
      idempotency_key: idempotencyKey,
      confirmed,
    }),
    annotations: stateful({ openWorld: true }),
    confirmation: 'always',
    executor: 'whatsapp',
    execute: (client, input) => client.request(
      'POST',
      `/v1/accounts/${pathPart(input.account_id)}/actions/${pathPart(input.action)}`,
      { headers: { 'idempotency-key': input.idempotency_key }, body: { args: input.args } },
    ),
  }),
  tool({
    name: 'whatsapp_command_get',
    title: 'Wait for WhatsApp command',
    description: 'Read or long-poll a durable gateway command until it completes or fails.',
    inputSchema: z.object({
      command_id: z.string().min(1),
      wait_seconds: z.number().int().min(0).max(30).default(30),
    }),
    annotations: readOnly(),
    confirmation: 'none',
    executor: 'control-plane',
    execute: (client, input) => client.request('GET', `/v1/commands/${pathPart(input.command_id)}`, {
      query: { wait_seconds: input.wait_seconds },
    }),
  }),
  tool({
    name: 'whatsapp_events_list',
    title: 'List WhatsApp events',
    description: 'Read normalized durable gateway events in sequence order for agent continuation and receive verification.',
    inputSchema: z.object({
      account_id: accountId.optional(),
      type: z.string().max(160).optional(),
      after_sequence: z.number().int().min(0).optional(),
      since: z.string().datetime().optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }),
    annotations: readOnly(),
    confirmation: 'none',
    executor: 'control-plane',
    execute: (client, input) => client.request('GET', '/v1/events', {
      query: {
        account_id: input.account_id,
        type: input.type,
        after_sequence: input.after_sequence,
        since: input.since,
        limit: input.limit,
      },
    }),
  }),
];

export function gatewayToolManifest() {
  return {
    name: 'kortix-mobile-whatsapp',
    version: '1.0.0',
    endpoint: '/mcp',
    transport: 'streamable-http-stateless',
    authentication: {
      bearer: 'Authorization: Bearer wag_...',
      api_key: 'X-API-Key: wag_...',
    },
    tools: gatewayTools.map((definition) => ({
      name: definition.name,
      title: definition.title,
      description: definition.description,
      input_schema: z.toJSONSchema(definition.inputSchema),
      annotations: definition.annotations,
      confirmation: definition.confirmation,
      executor: definition.executor,
    })),
  };
}
