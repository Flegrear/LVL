# LVL — Torrent streaming, video playback, and comic reading

**LVL** is a free, local-first Windows media player and library for **movies, TV series, anime, manga, and comics**. Stream video from torrents, manage your watch library, and read digital comics in one desktop app.

LVL runs on your computer. Your library and app settings are stored locally, while online catalog, subtitle, comic-source, and torrent services are contacted when you use them.

## What you can do

- **Stream torrents:** Open torrent-based video sources and start watching while the file downloads, with playback and seeking controls.
- **Watch your media:** Browse films, series, and anime in one library, with subtitles, audio-track selection, and playback preferences.
- **Read manga and comics:** Browse manga and use the built-in comic reader, including local CBZ/ZIP archives and supported online sources.
- **Customize subtitles:** Adjust subtitle appearance and optionally display romanized text for supported languages.
- **Keep your place:** Manage your library and track media within the app, with optional catalog integrations.

LVL is a media player and reader. It does not include movies, shows, or comic chapters. Use sources you have permission to access.

## Download for Windows

Download **[LVL-Setup.exe](https://github.com/Flegrear/LVL/releases/download/v0.2.0/LVL-Setup.exe)** to install the base version. Then open **Settings → Updates** in LVL to get the latest version. See [GitHub Releases](https://github.com/Flegrear/LVL/releases) for release history.

The installed app uses **127.0.0.1:4273** for its desktop window and browser tabs, sharing one local library.

## About the project

LVL combines torrent video playback and a manga/comic reader with a local-first media library. The source code is available in this repository. Licensing terms for reuse and redistribution have not yet been published.

## Release channels

Windows updates use `vX.Y.Z` releases and the Windows app checks for them
independently of Android releases. The next planned Windows version is **0.2.4**,
which will require a full installer because its updater is changing. Until that
installer is actually published, the link above remains the last released full
installer (`v0.2.0`); the app can then check for newer Windows versions in
Settings → Updates. The pop-up player's verified package is downloaded separately
when needed, not republished with every Windows version.

Android is being prepared as a **separate release channel** in the same repository.
The planned first version is **0.1.0**, under `android-v0.1.0`. After production
signing and publication approval, it will provide self-contained APKs for
arm64 and x86_64 devices, a distribution notice and checksums. Each APK includes
the components it needs to run; there is no separate native-build download for
users. Android releases will not replace the latest Windows release. **No Android
production release is available yet.** Existing Android debug builds are not
public installation or update packages. Android installation uses the platform's
package confirmation and signing protections.
