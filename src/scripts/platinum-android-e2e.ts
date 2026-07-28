import assert from 'node:assert/strict';
import { androidRuntimeProvider } from '../android/provider.js';
import type { ProvisionedAndroidRuntime } from '../android/types.js';

function endpoint(base: string, pathname: string): string {
  const url = new URL(base);
  url.pathname = pathname;
  return url.toString();
}

async function main() {
  const provider = androidRuntimeProvider();
  let runtime: ProvisionedAndroidRuntime | undefined;
  try {
    runtime = await provider.provision({ name: `wa-android-e2e-${Date.now()}` });
    assert.equal(runtime.health.android_booted, true);
    assert.match(runtime.health.whatsapp_version ?? '', /^\d+\.\d+\./);
    assert.equal(runtime.health.native_automation_ready, true);

    const [vncHtml, uiJs, externalHealth] = await Promise.all([
      fetch(new URL('/vnc.html?autoconnect=1&resize=scale', runtime.novncUrl)),
      fetch(new URL('/app/ui.js', runtime.novncUrl)),
      fetch(endpoint(runtime.controlUrl, '/health'), {
        headers: { authorization: `Bearer ${runtime.controlToken}` },
      }),
    ]);
    assert.equal(vncHtml.status, 200);
    assert.equal(uiJs.status, 200);
    assert.equal(externalHealth.status, 200);
    const externalHealthBody = await externalHealth.json() as {
      android_booted?: boolean;
      native_automation_ready?: boolean;
    };
    assert.equal(externalHealthBody.android_booted, true);
    assert.equal(externalHealthBody.native_automation_ready, true);

    await provider.action(runtime.providerInstanceId, { type: 'whatsapp.launch' });
    const uiSource = await provider.action(runtime.providerInstanceId, {
      type: 'ui.source',
    }) as { xml?: string };
    assert.ok((uiSource.xml?.length ?? 0) > 1_000);
    const notificationResult = await provider.action(runtime.providerInstanceId, {
      type: 'notifications.list',
    }) as { notifications?: unknown[] };
    assert.ok(Array.isArray(notificationResult.notifications));
    const egress = await provider.action(runtime.providerInstanceId, {
      type: 'network.egress',
    }) as {
      configured?: boolean;
      emulator_proxy_flag?: boolean;
      egress_differs?: boolean;
    };
    if (process.env.E2E_EXPECT_ANDROID_PROXY === '1') {
      assert.equal(egress.configured, true);
      assert.equal(egress.emulator_proxy_flag, true);
      assert.equal(egress.egress_differs, true);
    }
    const screenshot = await provider.action(runtime.providerInstanceId, {
      type: 'screen.screenshot',
    }) as { mime_type?: string; data_base64?: string };
    assert.equal(screenshot.mime_type, 'image/png');
    assert.ok((screenshot.data_base64?.length ?? 0) > 10_000);

    console.log(JSON.stringify({
      ok: true,
      provider: runtime.provider,
      provider_instance_id: runtime.providerInstanceId,
      source_provider_instance_id: runtime.sourceProviderInstanceId,
      snapshot_id: runtime.snapshotId,
      android_version: runtime.health.android_version,
      whatsapp_version: runtime.health.whatsapp_version,
      novnc_html_status: vncHtml.status,
      novnc_ui_status: uiJs.status,
      external_control_status: externalHealth.status,
      native_automation_ready: runtime.health.native_automation_ready,
      ui_source_bytes: uiSource.xml?.length,
      whatsapp_notifications: notificationResult.notifications?.length,
      proxy_configured: egress.configured,
      emulator_proxy_flag: egress.emulator_proxy_flag,
      proxy_egress_differs: egress.egress_differs,
      screenshot_bytes_base64: screenshot.data_base64?.length,
    }, null, 2));
  } finally {
    if (runtime && process.env.E2E_KEEP_ANDROID_INSTANCE !== '1') {
      await provider.destroy(runtime.providerInstanceId);
    }
  }
}

await main();
