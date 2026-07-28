import { HTTPException } from 'hono/http-exception';
import { config } from '../config.js';
import { PlatinumAndroidRuntimeProvider } from './providers/platinum.js';
import type { AndroidRuntimeProvider } from './types.js';

let provider: AndroidRuntimeProvider | undefined;

export function androidRuntimeProvider(): AndroidRuntimeProvider {
  if (config.ANDROID_RUNTIME_PROVIDER === 'disabled') {
    throw new HTTPException(503, {
      message: 'Native Android runtimes are disabled. Set ANDROID_RUNTIME_PROVIDER=platinum.',
    });
  }
  provider ??= new PlatinumAndroidRuntimeProvider();
  return provider;
}

export function setAndroidRuntimeProviderForTests(value: AndroidRuntimeProvider | undefined): void {
  provider = value;
}
