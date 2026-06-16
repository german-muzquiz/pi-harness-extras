---
name: flutter-dev
description: Instructions for working in a Flutter project. Covers running, building, testing and debugging a Flutter app on simulators/emulators/devices. Use when the task involves Flutter or Dart mobile development.
---

# Flutter Dev

## Prerequisite: Find the Project

Locate the Flutter project root (the directory containing `pubspec.yaml`). All commands below assume you `cd` into that directory first.

```bash
cd <project-root>
```

## Run the App

### Pick a Device

List available devices (simulators, emulators, and physical devices):

```bash
flutter devices
```

### iOS Simulator

Boot a simulator if none is running:

```bash
# List available simulators
xcrun simctl list devices available

# Boot one (use the UUID from the list above)
xcrun simctl boot <device-uuid>
open -a Simulator
```

### Android Emulator

```bash
# List available AVDs
flutter emulators

# Launch one
flutter emulators --launch <emulator-name>
```

### Physical Device

Connect via USB or wireless debugging.

### Launch with Hot Reload via tmux

Run `flutter run` inside a **named tmux session** so the process stays alive in the
background and you can send hot-reload commands to it without blocking your terminal.

```bash
# Start flutter run in a detached tmux session named "flutter"
tmux new-session -d -s flutter -c <project-root> "flutter run -d <device-id>"
```

Wait a few seconds for the build to finish and the app to launch on the device.

#### Hot Reload (after code changes)

Send the `r` key to the tmux session to trigger a hot reload (~sub-second, preserves state):

```bash
tmux send-keys -t flutter r
```

#### Hot Restart (reset state)

Send `R` to fully restart the Dart VM (resets all app state):

```bash
tmux send-keys -t flutter R
```

#### Check Session Output

Read the tmux session's scrollback to see build output, errors, or reload status:

```bash
tmux capture-pane -t flutter -p
```

#### Stop the App

```bash
tmux send-keys -t flutter q
```

Or kill the session entirely:

```bash
tmux kill-session -t flutter
```

### Verifying the UI

Take a screenshot of the running app and view it with the `read` tool:

```bash
flutter screenshot -d <device-id> -o /tmp/screenshot.png
```

Then inspect the image:

```
read /tmp/screenshot.png
```

Since you cannot navigate inside the app, you need to ask the user to navigate to the desired screen if you want to verify visual changes.

## Build the App

### iOS

```bash
# Debug IPA (for testing)
flutter build ios --debug

# Release IPA (requires signing identity and provisioning profile)
flutter build ios --release
```

The built `.app` bundle is in `build/ios/iphoneos/`.

To archive for App Store distribution:

```bash
flutter build ipa --release
```

The `.ipa` is in `build/ios/ipa/`.

### Installing to a Physical iOS Device (without uninstalling)

**Do NOT use `flutter install`** — it always uninstalls the existing app first, wiping user data.

Instead, use `xcrun devicectl` to install over the existing app, preserving data:

```bash
xcrun devicectl device install app --device <device-id> <path-to.app>
```

Example:

```bash
xcrun devicectl device install app --device 00008150-000A79D822E1401C build/ios/iphoneos/Runner.app
```

Get `<device-id>` from `flutter devices` (the long hex string in the second column).

### Android

```bash
# Debug APK
flutter build apk --debug

# Release APK
flutter build apk --release

# Release App Bundle (recommended for Play Store)
flutter build appbundle --release
```

Outputs are in `build/app/outputs/`.

## Run Automated Tests

### All Tests

```bash
flutter test
```

### Specific Test File or Directory

```bash
flutter test test/unit/
flutter test test/shared/models/money_test.dart
```

### With Coverage

```bash
flutter test --coverage
# Coverage report is in coverage/lcov.info
```

### Integration Tests

If the project has integration tests in `integration_test/`:

```bash
flutter test integration_test/
```

Or run them on a specific device:

```bash
flutter drive --driver=test_driver/integration_test.dart --target=integration_test/app_test.dart -d <device-id>
```

### Static Analysis

```bash
# Lint / analyze
flutter analyze

# Format (check only)
dart format --set-exit-if-changed .

# Format (fix in place)
dart format .
```

## Common Development Workflow

After a task that changed the code is completed:

1. Run static analysis: `flutter analyze`
2. Run unit tests: `flutter test`
3. If the change is visual, hot reload (`tmux send-keys -t flutter r`)
