/* global AbortSignal, fetch, setTimeout */

import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { URL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const configPath = process.env.ANDROID_CONTROL_CONFIG || '/var/lib/android-control/config.json';
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const adb = config.adb || '/opt/android-sdk/platform-tools/adb';
const whatsappPackage = config.whatsapp_package || 'com.whatsapp';
const appiumUrl = String(config.appium_url || 'http://127.0.0.1:4723').replace(/\/$/, '');
const proxyPath = '/var/lib/android-network/http-proxy-url';
const maxBodyBytes = 64 * 1024;
const elementKey = 'element-6066-11e4-a52e-4f735466cecf';
const agentVersion = '2026-07-28.1';
let appiumSessionId;

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function authorized(request) {
  const remote = request.socket.remoteAddress;
  const local = (remote === '127.0.0.1' || remote === '::1')
    && request.headers['x-android-control-local'] === '1';
  if (local) return true;
  return request.headers.authorization === `Bearer ${config.token}`;
}

async function readJson(request) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBodyBytes) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function runAdb(args, options = {}) {
  return execFileAsync(adb, args, {
    timeout: options.timeout ?? 30_000,
    maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
    encoding: options.encoding ?? 'utf8',
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function appiumRequest(method, pathname, payload, timeout = 30_000) {
  const response = await fetch(`${appiumUrl}${pathname}`, {
    method,
    headers: payload === undefined ? undefined : { 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(timeout),
  });
  const raw = await response.text();
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`Native automation returned invalid JSON (${response.status})`);
  }
  if (!response.ok || parsed?.value?.error) {
    const message = parsed?.value?.message || parsed?.message || raw || `HTTP ${response.status}`;
    throw new Error(`Native automation request failed: ${message}`);
  }
  return parsed.value ?? parsed;
}

async function appiumReady() {
  try {
    const status = await appiumRequest('GET', '/status', undefined, 3_000);
    return status?.ready !== false;
  } catch {
    return false;
  }
}

async function ensureAppiumSession() {
  if (appiumSessionId) {
    try {
      await appiumRequest('GET', `/session/${appiumSessionId}`, undefined, 5_000);
      return appiumSessionId;
    } catch {
      appiumSessionId = undefined;
    }
  }
  const value = await appiumRequest('POST', '/session', {
    capabilities: {
      alwaysMatch: {
        platformName: 'Android',
        'appium:automationName': 'UiAutomator2',
        'appium:udid': 'emulator-5554',
        'appium:appPackage': whatsappPackage,
        'appium:noReset': true,
        'appium:dontStopAppOnReset': true,
        'appium:newCommandTimeout': 600,
      },
      firstMatch: [{}],
    },
  }, 90_000);
  appiumSessionId = value?.sessionId;
  if (!appiumSessionId) throw new Error('Native automation did not return a session id');
  try {
    await runAdb([
      'shell',
      'cmd',
      'notification',
      'allow_listener',
      'io.appium.settings/io.appium.settings.NLService',
    ]);
  } catch {
    // Some Android builds grant this only after the settings helper has fully
    // started. getNotifications will return a clear error if access is absent.
  }
  return appiumSessionId;
}

function selector(input) {
  const using = String(input.using || '');
  const value = String(input.value || '');
  const allowed = ['accessibility id', 'id', '-android uiautomator', 'xpath'];
  if (!allowed.includes(using)) throw new Error('unsupported selector strategy');
  if (!value || value.length > 4000) throw new Error('selector value must contain 1 to 4000 characters');
  return { using, value };
}

function elementId(value) {
  const id = value?.[elementKey] || value?.ELEMENT;
  if (!id) throw new Error('Native automation did not return an element id');
  return id;
}

async function findElement(sessionId, input) {
  return elementId(await appiumRequest('POST', `/session/${sessionId}/element`, selector(input)));
}

async function openWhatsAppChat(input) {
  const phone = String(input.phone_number || '').replace(/\D/g, '');
  if (phone.length < 7 || phone.length > 20) throw new Error('phone_number must contain 7 to 20 digits');
  const message = typeof input.text === 'string' ? input.text.slice(0, 4000) : '';
  const url = `https://wa.me/${phone}${message ? `?text=${encodeURIComponent(message)}` : ''}`;
  await runAdb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url, '-p', whatsappPackage]);
  return { phone_number: phone, composed: Boolean(message) };
}

async function launchableApps(query) {
  const { stdout } = await runAdb([
    'shell', 'cmd', 'package', 'query-activities', '--brief',
    '-a', 'android.intent.action.MAIN',
    '-c', 'android.intent.category.LAUNCHER',
  ]);
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
  const seen = new Set();
  const apps = [];
  for (const line of stdout.split(/\r?\n/).map((value) => value.trim())) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)$/);
    if (!match || seen.has(line) || (needle && !line.toLowerCase().includes(needle))) continue;
    seen.add(line);
    apps.push({ package_name: match[1], activity: match[2] });
  }
  return { apps };
}

async function networkEgress() {
  let proxyUrl;
  try {
    proxyUrl = readFileSync(proxyPath, 'utf8').trim();
  } catch {
    return {
      configured: false,
      emulator_proxy_flag: false,
      egress_differs: false,
    };
  }
  let emulatorProxyFlag = false;
  try {
    const { stdout } = await execFileAsync('/usr/bin/pgrep', [
      '-f',
      '^/opt/android-sdk/emulator/qemu/linux-x86_64/qemu-system-x86_64 @whatsapp',
    ]);
    const pid = stdout.trim().split(/\s+/)[0];
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    const proxyIndex = argv.indexOf('-http-proxy');
    emulatorProxyFlag = proxyIndex >= 0 && argv[proxyIndex + 1] === proxyUrl;
  } catch {
    emulatorProxyFlag = false;
  }
  try {
    const request = ['--fail', '--silent', '--show-error', '--max-time', '20'];
    const endpoint = 'https://api.ipify.org';
    const [{ stdout: direct }, { stdout: proxied }] = await Promise.all([
      execFileAsync('/usr/bin/curl', [...request, endpoint]),
      execFileAsync('/usr/bin/curl', [...request, '--proxy', proxyUrl, endpoint]),
    ]);
    const directIp = direct.trim();
    const proxyIp = proxied.trim();
    return {
      configured: true,
      emulator_proxy_flag: emulatorProxyFlag,
      direct_egress_ip: directIp,
      proxy_egress_ip: proxyIp,
      egress_differs: Boolean(directIp && proxyIp && directIp !== proxyIp),
    };
  } catch {
    return {
      configured: true,
      emulator_proxy_flag: emulatorProxyFlag,
      egress_differs: false,
      error: 'proxy connectivity check failed',
    };
  }
}

async function health() {
  const [{ stdout: adbState }, { stdout: boot }, { stdout: androidVersion }, { stdout: activities }, { stdout: pkg }, nativeAutomationReady] =
    await Promise.all([
      runAdb(['get-state']),
      runAdb(['shell', 'getprop', 'sys.boot_completed']),
      runAdb(['shell', 'getprop', 'ro.build.version.release']),
      runAdb(['shell', 'dumpsys', 'activity', 'activities']),
      runAdb(['shell', 'dumpsys', 'package', whatsappPackage]),
      appiumReady(),
    ]);
  const foreground = activities.match(/(?:topResumedActivity|mResumedActivity)=ActivityRecord\{[^}]* ([^ ]+) /)?.[1];
  const whatsappVersion = pkg.match(/versionName=([^\s]+)/)?.[1];
  return {
    agent_version: agentVersion,
    android_booted: boot.trim() === '1',
    adb_state: adbState.trim(),
    android_version: androidVersion.trim(),
    whatsapp_version: whatsappVersion,
    foreground_activity: foreground,
    native_automation_ready: nativeAutomationReady,
  };
}

function integer(value, name, min = 0, max = 10000) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return String(value);
}

async function action(input) {
  switch (input.type) {
    case 'whatsapp.launch':
      await runAdb(['shell', 'monkey', '-p', whatsappPackage, '-c', 'android.intent.category.LAUNCHER', '1']);
      return { ok: true };
    case 'whatsapp.compose': {
      return { ok: true, ...await openWhatsAppChat(input) };
    }
    case 'whatsapp.open_chat':
      return { ok: true, ...await openWhatsAppChat(input) };
    case 'whatsapp.send_text': {
      if (typeof input.text !== 'string' || !input.text || input.text.length > 4000) {
        throw new Error('text must contain 1 to 4000 characters');
      }
      const opened = await openWhatsAppChat(input);
      const deadline = Date.now() + Number(integer(input.timeout_ms ?? 20_000, 'timeout_ms', 1_000, 60_000));
      const sessionId = await ensureAppiumSession();
      const candidates = [
        { using: 'id', value: `${whatsappPackage}:id/send` },
        { using: '-android uiautomator', value: 'new UiSelector().descriptionContains("Send")' },
      ];
      let lastError;
      while (Date.now() < deadline) {
        for (const candidate of candidates) {
          try {
            const id = await findElement(sessionId, candidate);
            await appiumRequest('POST', `/session/${sessionId}/element/${id}/click`, {});
            return { ok: true, sent: true, ...opened };
          } catch (error) {
            lastError = error;
          }
        }
        await sleep(500);
      }
      throw new Error(`WhatsApp send button was not available: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    }
    case 'whatsapp.force_stop':
      await runAdb(['shell', 'am', 'force-stop', whatsappPackage]);
      return { ok: true };
    case 'apps.list':
      return launchableApps(input.query);
    case 'app.open': {
      const packageName = String(input.package_name || '');
      if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(packageName)) {
        throw new Error('invalid package_name');
      }
      await runAdb(['shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1']);
      return { ok: true, package_name: packageName };
    }
    case 'url.open': {
      const url = new URL(String(input.url || ''));
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('url must use http or https');
      await runAdb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url.toString()]);
      return { ok: true, url: url.toString() };
    }
    case 'notifications.list': {
      const sessionId = await ensureAppiumSession();
      const notifications = await appiumRequest('POST', `/session/${sessionId}/execute/sync`, {
        script: 'mobile: getNotifications',
        args: [],
      });
      const all = Array.isArray(notifications?.statusBarNotifications)
        ? notifications.statusBarNotifications
        : [];
      return {
        notifications: all.filter((item) => item?.packageName === whatsappPackage),
        buffered_total: all.length,
      };
    }
    case 'notifications.open_shade':
      await runAdb(['shell', 'cmd', 'statusbar', 'expand-notifications']);
      return { ok: true };
    case 'network.egress':
      return networkEgress();
    case 'screen.screenshot': {
      const { stdout } = await runAdb(['exec-out', 'screencap', '-p'], {
        encoding: 'buffer',
        maxBuffer: 16 * 1024 * 1024,
      });
      return { mime_type: 'image/png', data_base64: Buffer.from(stdout).toString('base64') };
    }
    case 'ui.dump': {
      await runAdb(['shell', 'uiautomator', 'dump', '/sdcard/window.xml']);
      const { stdout } = await runAdb(['exec-out', 'cat', '/sdcard/window.xml']);
      return { xml: stdout };
    }
    case 'ui.source': {
      const sessionId = await ensureAppiumSession();
      return { xml: await appiumRequest('GET', `/session/${sessionId}/source`) };
    }
    case 'ui.find': {
      const sessionId = await ensureAppiumSession();
      return { element_id: await findElement(sessionId, input) };
    }
    case 'ui.find_all': {
      const sessionId = await ensureAppiumSession();
      const elements = await appiumRequest('POST', `/session/${sessionId}/elements`, selector(input));
      return { element_ids: (Array.isArray(elements) ? elements : []).map(elementId) };
    }
    case 'ui.click': {
      const sessionId = await ensureAppiumSession();
      const id = await findElement(sessionId, input);
      await appiumRequest('POST', `/session/${sessionId}/element/${id}/click`, {});
      return { ok: true, element_id: id };
    }
    case 'ui.set_value': {
      const text = String(input.text ?? '');
      if (!text || text.length > 4000) throw new Error('text must contain 1 to 4000 characters');
      const sessionId = await ensureAppiumSession();
      const id = await findElement(sessionId, input);
      await appiumRequest('POST', `/session/${sessionId}/element/${id}/value`, { text });
      return { ok: true, element_id: id };
    }
    case 'input.tap':
      await runAdb(['shell', 'input', 'tap', integer(input.x, 'x'), integer(input.y, 'y')]);
      return { ok: true };
    case 'input.long_press':
      await runAdb([
        'shell', 'input', 'swipe',
        integer(input.x, 'x'), integer(input.y, 'y'),
        integer(input.x, 'x'), integer(input.y, 'y'),
        integer(input.duration_ms ?? 800, 'duration_ms', 250, 10_000),
      ]);
      return { ok: true };
    case 'input.swipe':
      await runAdb([
        'shell', 'input', 'swipe',
        integer(input.x1, 'x1'), integer(input.y1, 'y1'),
        integer(input.x2, 'x2'), integer(input.y2, 'y2'),
        integer(input.duration_ms ?? 300, 'duration_ms', 0, 10_000),
      ]);
      return { ok: true };
    case 'input.text': {
      const text = String(input.text ?? '');
      if (!text || text.length > 1000) throw new Error('text must contain 1 to 1000 characters');
      await runAdb(['shell', 'input', 'text', text.replaceAll(' ', '%s')]);
      return { ok: true };
    }
    case 'input.keyevent': {
      const keycode = String(input.keycode || '').toUpperCase();
      if (!/^(?:KEYCODE_[A-Z0-9_]+|[0-9]{1,3})$/.test(keycode)) throw new Error('invalid keycode');
      await runAdb(['shell', 'input', 'keyevent', keycode]);
      return { ok: true };
    }
    case 'clipboard.set': {
      const text = String(input.text ?? '');
      if (text.length > 20_000) throw new Error('text must contain at most 20000 characters');
      const sessionId = await ensureAppiumSession();
      await appiumRequest('POST', `/session/${sessionId}/execute/sync`, {
        script: 'mobile: setClipboard',
        args: [{
          content: Buffer.from(text).toString('base64'),
          contentType: 'plaintext',
          label: 'Kortix',
        }],
      });
      return { ok: true, characters: text.length };
    }
    case 'clipboard.paste':
      await runAdb(['shell', 'input', 'keyevent', 'KEYCODE_PASTE']);
      return { ok: true };
    case 'share.text': {
      const text = String(input.text ?? '');
      if (!text || text.length > 20_000) throw new Error('text must contain 1 to 20000 characters');
      await runAdb([
        'shell', 'am', 'start',
        '-a', 'android.intent.action.SEND',
        '-t', 'text/plain',
        '--es', 'android.intent.extra.TEXT', text,
      ]);
      return { ok: true, characters: text.length };
    }
    default:
      throw new Error('unsupported action');
  }
}

const server = createServer(async (request, response) => {
  try {
    if (!authorized(request)) return json(response, 401, { error: 'unauthorized' });
    const url = new URL(request.url, 'http://android-control.local');
    if (request.method === 'GET' && url.pathname === '/health') {
      return json(response, 200, await health());
    }
    if (request.method === 'POST' && url.pathname === '/v1/actions') {
      return json(response, 200, await action(await readJson(request)));
    }
    return json(response, 404, { error: 'not_found' });
  } catch (error) {
    return json(response, 400, {
      error: 'request_failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(config.port || 8787, '0.0.0.0', () => {
  process.stdout.write(`${JSON.stringify({ event: 'android_control_listening', port: config.port || 8787 })}\n`);
});
