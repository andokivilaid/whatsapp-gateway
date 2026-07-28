#!/usr/bin/env bash
set -euo pipefail

node_version=v22.22.0
appium_version=3.6.0
uiautomator2_version=8.2.0
archive="node-${node_version}-linux-x64.tar.xz"

if [[ ! -x /opt/node22/bin/node ]]; then
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  curl -fsSLo "$work/$archive" "https://nodejs.org/dist/${node_version}/$archive"
  checksum=$(
    curl -fsSL "https://nodejs.org/dist/${node_version}/SHASUMS256.txt" |
      awk -v file="$archive" '$2 == file {print $1}'
  )
  [[ -n "$checksum" ]]
  printf '%s  %s\n' "$checksum" "$work/$archive" | sha256sum -c -
  mkdir -p /opt/node22
  tar -xJf "$work/$archive" --strip-components=1 -C /opt/node22
fi

export PATH=/opt/node22/bin:/usr/bin:/bin
export APPIUM_HOME=/opt/appium-home
export ANDROID_HOME=/opt/android-sdk
export ANDROID_SDK_ROOT=/opt/android-sdk

mkdir -p /opt/appium /opt/appium-home
if [[ ! -x /opt/appium/node_modules/.bin/appium ]]; then
  npm install \
    --prefix /opt/appium \
    --omit=dev \
    --no-audit \
    --no-fund \
    "appium@${appium_version}"
fi

if ! /opt/appium/node_modules/.bin/appium driver list --installed --json |
  grep -q '"uiautomator2"'; then
  /opt/appium/node_modules/.bin/appium driver install \
    --source=npm \
    "appium-uiautomator2-driver@${uiautomator2_version}"
fi

/opt/node22/bin/node --version
/opt/appium/node_modules/.bin/appium --version
/opt/appium/node_modules/.bin/appium driver list --installed --json
