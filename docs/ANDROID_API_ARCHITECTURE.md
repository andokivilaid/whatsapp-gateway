# Android WhatsApp API architecture

There is no public API inside the ordinary WhatsApp Android APK that exposes
its chats, contacts, groups, message database, or transport connection. Android
intents can open a chat or share content, and notification APIs can observe or
reply to some notifications, but neither surface is a complete WhatsApp API.

Any product claiming a complete self-hosted personal-account API uses one of
four mechanisms:

1. the unofficial multi-device protocol (Baileys, whatsmeow, WPPConnect-class
   projects);
2. WhatsApp Web browser automation;
3. Android UI/accessibility automation;
4. root, Frida, Xposed, APK modification, or private-database extraction.

The fourth option is intentionally excluded. It weakens the device, tightly
couples the service to WhatsApp internals, and carries the highest account and
security risk.

## Recommended modes

### Business numbers: official coexistence

Meta's WhatsApp Business Platform supports onboarding an existing WhatsApp
Business App number to Cloud API through Embedded Signup. The mobile Business
app remains usable while Cloud API provides network-level send/receive,
webhooks, media, interactive messages, calling, and supported group APIs.

Current official requirements and behavior include:

- WhatsApp Business App 2.24.17 or newer;
- a Solution Partner or Tech Provider integration using Embedded Signup;
- a working Cloud API webhook;
- `GET /v25.0/{phone-number-id}?fields=is_on_biz_app,platform_type` reports
  `is_on_biz_app: true` and `platform_type: CLOUD_API`;
- up to six months of eligible one-to-one message/contact history is
  synchronized during onboarding;
- Business App messages do not open or affect Cloud API customer-service
  windows or pricing;
- coexistence still restricts or excludes some mobile features, including
  disappearing/view-once messages, live location, broadcast lists, and some
  group behavior.

Official reference:
[Onboard WhatsApp Business app users](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users).

This is the best answer when the number can be a business number: keep the
native Android app and use the official network API. No Baileys or UI selector
is required for normal messaging.

### Consumer/personal numbers: Android primary plus linked companion

For an ordinary account, the practical full-API topology is:

```text
Persistent Platinum Android (primary device)
└── native WhatsApp account and durable phone session

WhatsApp Gateway account (linked companion)
└── Baileys multi-device session and the existing normalized REST API
```

This keeps the primary account completely cloud-hosted on Android while
retaining the gateway's existing chats, contacts, groups, messages, media,
receipts, presence, communities, newsletters, calls, and business-action
surface. It is still an unofficial linked-device client and can disconnect,
but loss of a physical phone no longer takes the primary account offline.

Create the Android instance with `account_id` to persist this one-to-one
association. Enroll WhatsApp on Android, then use
`POST /v1/accounts/{accountId}/pair/code` and complete **Link with phone
number** in the Android app. Keep the resulting Android sandbox and Baileys
auth state; never clone either enrolled identity.

### Direct native controller

The gateway's Appium/UiAutomator2 path is the fallback for phone-only actions:

- open or send to chats through the real Android app;
- read and act on the visible UI hierarchy;
- retrieve the recent WhatsApp notification buffer;
- tap, swipe, type, and take screenshots;
- access features not represented by the companion API.

It does not become a lossless message database. Selectors can change with
WhatsApp releases, muted chats may not notify, the notification buffer is
bounded, and only visible/loaded UI can be inspected.

## OpenPhone evaluation

OpenPhone v0.0.3 is a promising generic agentic Android OS, but it is not a
WhatsApp network API or an out-of-the-box replacement today:

- the published v0.0.3 binary is a Pixel 9a OTA, not an x86_64 emulator image;
- the repository calls the release a developer preview;
- its release notes say the full autonomous loop and framework-owned UI
  hierarchy extraction are still in progress;
- Google apps/GMS are not distributed;
- its `messages.*`, notifications, screen, and input protocol is a generic
  phone capability layer, not access to WhatsApp's private chat database.

Its architecture could replace Appium later after a validated x86_64 image and
implemented phone services exist. It does not remove the need for either Cloud
API coexistence, a linked companion, or app-level automation.

## Decision

- Use official Cloud API coexistence for eligible business numbers.
- Use Platinum Android primary plus the existing linked-device REST API for
  personal accounts that need broad normalized automation.
- Keep Appium as the native escape hatch, enrollment UI, health surface, and
  fallback—not as the sole source of message truth.
