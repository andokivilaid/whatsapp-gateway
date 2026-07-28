export type AndroidRuntimeState =
  | 'provisioning'
  | 'running'
  | 'stopped'
  | 'failed'
  | 'deleted'
  | 'unknown';

export type AndroidControlAction =
  | { type: 'whatsapp.launch' }
  | { type: 'whatsapp.compose'; phone_number: string; text?: string }
  | { type: 'whatsapp.open_chat'; phone_number: string; text?: string }
  | { type: 'whatsapp.send_text'; phone_number: string; text: string; timeout_ms?: number }
  | { type: 'whatsapp.force_stop' }
  | { type: 'apps.list'; query?: string }
  | { type: 'app.open'; package_name: string }
  | { type: 'url.open'; url: string }
  | { type: 'notifications.list' }
  | { type: 'notifications.open_shade' }
  | { type: 'network.egress' }
  | { type: 'screen.screenshot' }
  | { type: 'ui.dump' }
  | { type: 'ui.source' }
  | { type: 'ui.find'; using: AndroidSelectorStrategy; value: string }
  | { type: 'ui.find_all'; using: AndroidSelectorStrategy; value: string }
  | { type: 'ui.click'; using: AndroidSelectorStrategy; value: string }
  | { type: 'ui.set_value'; using: AndroidSelectorStrategy; value: string; text: string }
  | { type: 'input.tap'; x: number; y: number }
  | { type: 'input.long_press'; x: number; y: number; duration_ms?: number }
  | { type: 'input.swipe'; x1: number; y1: number; x2: number; y2: number; duration_ms?: number }
  | { type: 'input.text'; text: string }
  | { type: 'input.keyevent'; keycode: string }
  | { type: 'clipboard.set'; text: string }
  | { type: 'clipboard.paste' }
  | { type: 'share.text'; text: string };

export type AndroidSelectorStrategy =
  | 'accessibility id'
  | 'id'
  | '-android uiautomator'
  | 'xpath';

export type AndroidRuntimeHealth = {
  provider_state: string;
  android_booted: boolean;
  agent_version?: string;
  adb_state?: string;
  android_version?: string;
  whatsapp_version?: string;
  foreground_activity?: string;
  native_automation_ready?: boolean;
  error?: string;
};

export type ProvisionAndroidRuntimeInput = {
  name: string;
  proxyUrl?: string;
};

export type ProvisionedAndroidRuntime = {
  provider: 'platinum';
  providerInstanceId: string;
  sourceProviderInstanceId: string;
  snapshotId: string;
  state: AndroidRuntimeState;
  controlUrl: string;
  controlToken: string;
  novncUrl: string;
  vncPassword: string;
  health: AndroidRuntimeHealth;
  metadata: Record<string, unknown>;
};

export type UpgradeAndroidRuntimeInput = {
  controlToken: string;
  vncPassword: string;
  proxyUrl?: string;
};

export interface AndroidRuntimeProvider {
  readonly name: 'platinum';
  provision(input: ProvisionAndroidRuntimeInput): Promise<ProvisionedAndroidRuntime>;
  inspect(providerInstanceId: string): Promise<AndroidRuntimeHealth>;
  upgrade(providerInstanceId: string, input: UpgradeAndroidRuntimeInput): Promise<AndroidRuntimeHealth>;
  action(providerInstanceId: string, action: AndroidControlAction): Promise<unknown>;
  start(providerInstanceId: string): Promise<AndroidRuntimeHealth>;
  stop(providerInstanceId: string): Promise<void>;
  destroy(providerInstanceId: string): Promise<void>;
}
