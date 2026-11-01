# LVL — Language Video Learner

LVL is a **local-first video player and media Library** for series, anime, and movies.

## Features

- **Watch:** play supported local and torrent media, switch audio tracks and subtitles.
- **Subtitles:** select embedded tracks, import or search captions, customize their appearance and timing, and display romanized text.
- **Library:** browse titles and seasons, organize sources, track progress, and follow releases in a Calendar.
- **Discover:** rate titles, get personalized daily recommendations, and connect AniList or import Letterboxd ratings.
- **Comics:** read manga, manhwa and manhua from your own files or from comic sources you add, with a manga's chapters on its anime's page.
- **Keep control:** save your Library locally, with in-app update and notification settings.

**LVL is in alpha**, focused on playback and Library reliability. Learning, flashcards, Review, and Coach are deferred.

## Getting started

Download **LVL-Setup.exe** from the [latest release](https://github.com/Flegrear/LVL/releases/latest). It installs the newest version, and LVL updates itself from then on. The installed app uses **127.0.0.1:4273** for its desktop window and browser tabs, sharing one Library.

LVL stores application data locally; catalog, subtitle, and torrent services may be contacted when used.

## Run from source

With Node.js 22 and Git, run `npm ci`, then `npm start`, and open http://127.0.0.1:4173. Comics also needs the extension runner, which the installer includes. In a source checkout, build it once with `npm run runner`: it downloads the pinned Eclipse Temurin JDK, the Suwayomi sources and the runner's libraries, and takes a few minutes.
