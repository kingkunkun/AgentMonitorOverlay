#!/bin/bash
# WorkStudio iOS build on the low packaging Mac (172.16.8.160), run by the Jenkins job WorkStudio_iOS.
# Kotlin framework -> archive -> sign with the workstudio profile -> .ipa -> validate -> TestFlight.
#   nice -n 10 bash build-low-mac.sh <studio/mobile folder> <version> <build number> [--no-upload]
# The certificate and profile are the ones already on this Mac; nothing here creates, changes or removes them.
# Every step logs to ~/workstudio-build/logs/<version>-<build>/NN-<step>.log and the exit code says where it stopped.
set -u
MOBILE=$(cd "${1:?studio/mobile folder}" && pwd)
VERSION=${2:?version}
BUILD=${3:?build number}
UPLOAD=1
[ "${4:-}" = "--no-upload" ] && UPLOAD=0

ROOT=$HOME/workstudio-build
RUN=$ROOT/runs/$VERSION-$BUILD
LOGS=$ROOT/logs/$VERSION-$BUILD
mkdir -p "$RUN" "$LOGS"
STEP=0
TOTAL=7
PROFILE_NAME=${PROFILE_NAME:-workstudio}
APP_ID_EXPECTED=${APP_ID_EXPECTED:-D39JR23NC7.com.gorilla.workstudio}
JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}
export JAVA_HOME
export PATH="$JAVA_HOME/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

say() { printf '%s\n' "$*"; }
step() { STEP=$1; NAME=$2; LOG=$LOGS/$(printf '%02d' "$1")-$2.log; say "[$1/$TOTAL] $3"; }
fail() {
  say "✗ 打包停在第 $STEP 步「$NAME」：$1"
  [ -f "$LOG" ] && { say "--- $LOG 最后 40 行 ---"; tail -n 40 "$LOG"; }
  exit $((10 + STEP))
}
run() { "$@" >>"$LOG" 2>&1 || fail "命令失败：$1，日志 $LOG"; }

step 1 busy "打包机忙不忙"
: >"$LOG"
if pgrep -f 'Unity.*-batchmode' >/dev/null; then fail "Unity 正在出包，稍后再跑"; fi
if pgrep -lf '^[^ ]*xcodebuild( |$)' | grep -v -- '-downloadPlatform' >>"$LOG"; then fail "已经有 xcodebuild 在跑，稍后再跑"; fi
say "  空闲"

step 2 config "描述文件、签名身份、JDK"
: >"$LOG"
[ -x "$JAVA_HOME/bin/java" ] || fail "JDK 不在 $JAVA_HOME"
PROFILE=""
for f in "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"/*.mobileprovision "$HOME/Library/MobileDevice/Provisioning Profiles"/*.mobileprovision; do
  [ -f "$f" ] || continue
  if security cms -D -i "$f" 2>/dev/null | grep -q "<string>$PROFILE_NAME</string>"; then PROFILE=$f; break; fi
done
[ -n "$PROFILE" ] || fail "打包机上没有描述文件 $PROFILE_NAME"
security cms -D -i "$PROFILE" >"$RUN/profile.plist" 2>>"$LOG" || fail "读不了描述文件 $PROFILE"
APP_ID=$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:application-identifier' "$RUN/profile.plist" 2>>"$LOG") || fail "描述文件里没有 App ID"
[ "$APP_ID" = "$APP_ID_EXPECTED" ] || fail "描述文件的 App ID 是 $APP_ID，不是 $APP_ID_EXPECTED"
IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/^ *[0-9]*) \([0-9A-F]\{40\}\) "Apple Distribution: .*(D39JR23NC7)"$/\1/p' | head -n 1)
[ -n "$IDENTITY" ] || fail "登录钥匙串里没有 Apple Distribution (D39JR23NC7)"
# 从 ssh 进来时钥匙串是锁着的，codesign 会报 errSecInternalComponent；密码只放在这台机器的 ~/.workstudio 里。
KEYCHAIN_PASSWORD_FILE=$HOME/.workstudio/keychain-password
if [ -f "$KEYCHAIN_PASSWORD_FILE" ]; then
  KC_PASSWORD=$(cat "$KEYCHAIN_PASSWORD_FILE")
  security unlock-keychain -p "$KC_PASSWORD" "$HOME/Library/Keychains/login.keychain-db" >>"$LOG" 2>&1 || fail "登录钥匙串解不开"
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KC_PASSWORD" "$HOME/Library/Keychains/login.keychain-db" >>"$LOG" 2>&1 || true
fi
say "  $PROFILE_NAME、$APP_ID、签名身份都在"

step 3 kotlin "编译共用 Kotlin（Shared.framework）"
: >"$LOG"
cd "$MOBILE" || fail "没有 $MOBILE"
chmod +x gradlew
run nice -n 10 ./gradlew --no-daemon --max-workers=2 "-Dorg.gradle.jvmargs=-Xmx4g -Dfile.encoding=UTF-8" :shared:linkReleaseFrameworkIosArm64

step 4 archive "xcodebuild archive（先不签名）"
: >"$LOG"
ARCHIVE=$RUN/WorkStudio.xcarchive
rm -rf "$ARCHIVE"
run nice -n 10 xcodebuild archive -project "$MOBILE/iosApp/iosApp.xcodeproj" -scheme iosApp -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" -derivedDataPath "$RUN/DerivedData" \
  MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD" CODE_SIGNING_ALLOWED=NO
APP_SRC=$(find "$ARCHIVE/Products/Applications" -maxdepth 1 -name '*.app' | head -n 1)
[ -n "$APP_SRC" ] || fail "archive 里没有 .app"

step 5 export "签名、打成 .ipa"
: >"$LOG"
EXPORT=$RUN/export
rm -rf "$EXPORT"
mkdir -p "$EXPORT/Payload"
APP=$EXPORT/Payload/$(basename "$APP_SRC")
run ditto "$APP_SRC" "$APP"
cp "$PROFILE" "$APP/embedded.mobileprovision"
cat >"$EXPORT/entitlements.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>application-identifier</key><string>$APP_ID</string>
<key>com.apple.developer.team-identifier</key><string>D39JR23NC7</string>
<key>get-task-allow</key><false/>
<key>beta-reports-active</key><true/>
</dict></plist>
EOF
shopt -s nullglob
for nested in "$APP"/Frameworks/*; do
  run codesign --force --sign "$IDENTITY" --timestamp "$nested"
done
run codesign --force --sign "$IDENTITY" --timestamp --entitlements "$EXPORT/entitlements.plist" --generate-entitlement-der "$APP"
run codesign --verify --strict --verbose=2 "$APP"
IPA=$EXPORT/WorkStudio.ipa
( cd "$EXPORT" && zip -qry "$IPA" Payload ) >>"$LOG" 2>&1 || fail "打 .ipa 失败"
say "  $IPA"

step 6 validate "让苹果校验这个包"
: >"$LOG"
CONFIG=$HOME/.amo-ios/config
ASC_KEY_ID=""; ASC_ISSUER_ID=""
if [ -f "$CONFIG" ]; then
  ASC_KEY_ID=$(sed -n 's/^ASC_KEY_ID=//p' "$CONFIG" | tail -n 1)
  ASC_ISSUER_ID=$(sed -n 's/^ASC_ISSUER_ID=//p' "$CONFIG" | tail -n 1)
fi
HAVE_KEY=0
if [ -n "$ASC_KEY_ID" ] && [ -n "$ASC_ISSUER_ID" ] && [ -f "$HOME/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8" ]; then HAVE_KEY=1; fi
HAVE_APPLE_ID=0
ASC_CREDENTIALS=$HOME/.workstudio/asc-credential
ASC_PROVIDER_ID=${ASC_PROVIDER_ID:-8cc1e07d-d16a-4d06-b718-224309a4d511}
if [ -f "$ASC_CREDENTIALS" ]; then
  ASC_USER=$(cut -f1 "$ASC_CREDENTIALS" 2>/dev/null)
  ASC_PASSWORD=$(cut -f2 "$ASC_CREDENTIALS" 2>/dev/null)
  if [ -n "$ASC_USER" ] && [ -n "$ASC_PASSWORD" ]; then HAVE_APPLE_ID=1; fi
fi
if [ $HAVE_KEY = 1 ] || [ $HAVE_APPLE_ID = 1 ]; then
  if [ $HAVE_KEY = 1 ]; then
    run xcrun altool --validate-app -f "$IPA" -t ios --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"
  else
    run xcrun altool --validate-app -f "$IPA" -t ios -u "$ASC_USER" -p "$ASC_PASSWORD" --provider-public-id "$ASC_PROVIDER_ID"
  fi
  say "  通过"
else
  say "  跳过：还没有 App Store Connect API Key"
fi

step 7 upload "上传到 TestFlight"
: >"$LOG"
HAVE_UPLOAD_CREDENTIAL=0
if [ $HAVE_KEY = 1 ] || [ $HAVE_APPLE_ID = 1 ]; then HAVE_UPLOAD_CREDENTIAL=1; fi
if [ $UPLOAD = 1 ] && [ $HAVE_UPLOAD_CREDENTIAL = 1 ]; then
  if [ $HAVE_KEY = 1 ]; then
    run xcrun altool --upload-app -f "$IPA" -t ios --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"
  else
    run xcrun altool --upload-app -f "$IPA" -t ios -u "$ASC_USER" -p "$ASC_PASSWORD" --provider-public-id "$ASC_PROVIDER_ID"
  fi
  say "  已上传：$VERSION ($BUILD)"
else
  if [ $UPLOAD = 0 ]; then say "  跳过：--no-upload"; else say "  跳过：还没有 App Store Connect API Key"; fi
fi
cat >"$RUN/build.json" <<EOF
{"version":"$VERSION","build":"$BUILD","ipa":"$IPA","uploaded":$([ "$UPLOAD" = 1 ] && [ "$HAVE_UPLOAD_CREDENTIAL" = 1 ] && echo true || echo false),"finishedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF
say "✓ iOS $VERSION ($BUILD) 完成"
