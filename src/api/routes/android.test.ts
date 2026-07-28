import { describe, expect, it } from 'vitest';
import { encryptJson } from '../../crypto.js';
import { androidActionSchema, decryptAndroidInstanceCredentials } from './android.js';

describe('native Android API contract', () => {
  it('accepts bounded actions and rejects arbitrary shell input', () => {
    expect(androidActionSchema.parse({ type: 'input.tap', x: 200, y: 400 })).toEqual({
      type: 'input.tap',
      x: 200,
      y: 400,
    });
    expect(androidActionSchema.safeParse({ type: 'shell.exec', command: 'rm -rf /' }).success).toBe(false);
    expect(androidActionSchema.safeParse({ type: 'input.tap', x: -1, y: 400 }).success).toBe(false);
    expect(androidActionSchema.safeParse({
      type: 'whatsapp.compose',
      phone_number: '+14155550123',
      text: 'hello',
    }).success).toBe(true);
    expect(androidActionSchema.safeParse({
      type: 'whatsapp.send_text',
      phone_number: '+14155550123',
      text: 'hello from native Android',
    }).success).toBe(true);
    expect(androidActionSchema.safeParse({
      type: 'ui.click',
      using: 'id',
      value: 'com.whatsapp:id/send',
    }).success).toBe(true);
  });

  it('keeps control and VNC credentials encrypted at rest', () => {
    const record = {
      encryptedControlUrl: encryptJson('https://control.example/?t=secret'),
      encryptedControlToken: encryptJson('control-secret'),
      encryptedVncPassword: encryptJson('vnc-pass'),
    };
    expect(JSON.stringify(record)).not.toContain('control-secret');
    expect(decryptAndroidInstanceCredentials(record)).toEqual({
      control_url: 'https://control.example/?t=secret',
      control_token: 'control-secret',
      vnc_password: 'vnc-pass',
      proxy_url: null,
    });
  });
});
