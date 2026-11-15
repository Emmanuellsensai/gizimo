# Gizimo

A customizable voice and character companion for your computer. It lives as a floating 3D avatar, talks and listens,
wakes when you say its name, and can do a few safe things on your PC. Early software: built and tested on Windows 11.

## What it does today

- Chat with a character you define (personality, languages, check-ins) using Claude Haiku with **your own** Anthropic key,
  stored in the Windows Credential Manager and never written to a file.
- Speaks replies and listens, on your device: Windows voices, the Kokoro on-device voice (when your PC is fast enough),
  and Whisper for speech recognition. Optional native engine for your own Whisper-format model.
- A 3D avatar (VRM) standing in a floating, always-on-top, resizable window you can move to any screen, with a lip-synced
  mouth, blinking and breathing. A gallery of free CC0 avatars, or add your own `.vrm` file.
- Wake phrase (default "hey Gizimo"): you record the phrase a few times; matching runs on your PC and nothing is
  recorded or sent anywhere.
- Skills with safety limits: read-only and reversible tiers, per-character allow-lists, a kill switch
  (Ctrl+Alt+Shift+K), and an activity log. Anything with side effects is not available yet.

## Build it

You need Node 22+, Rust (stable) and, on Windows, the Visual Studio C++ Build Tools. On Ubuntu:

```bash
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev pkg-config
```

Then, from the `app` folder:

```bash
npm install
npm test                 # JavaScript tests
npm run tauri dev        # run it
npm run tauri build      # make an installer (Windows: .exe, Ubuntu: .deb and .AppImage)
```

Rust tests: `cd app/src-tauri && cargo test`.

## Downloads at run time

Models are fetched when first used, never stored in this repository, and each is accepted only if it matches a SHA-256
recorded in the code: the Whisper models (Hugging Face), the Kokoro voice, the gallery avatars (Arweave), and the two
wake word models (openWakeWord, GitHub). See `THIRD_PARTY.md` for sources and licences.

## Platforms

Windows 11 is the tested platform. Ubuntu builds are produced by the release workflow but have not been tested by hand;
expect rough edges (always-on-top and global hotkeys depend on X11 versus Wayland, and the GPU-based voice paths are
Windows-only for now).

## Licence

Not decided yet. Until a licence file is added, all rights are reserved by the author.
