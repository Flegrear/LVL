# Learning preset data provenance

The learning preset API serves small derived frequency slices stored in this folder. The files are data, not application code, and keep their upstream licensing/attribution requirements.

## Word presets

`*.words.tsv` contains the first 5,000 usable entries, in source frequency order, derived from **FrequencyWords** by Hermit Dave at commit `525f9b560de45753a5ea01069454e72e9aa541c6`.

- Upstream: https://github.com/hermitdave/FrequencyWords
- Corpus origin: OpenSubtitles2018 / OPUS
- Upstream content license: **CC BY-SA 4.0**
- License: https://creativecommons.org/licenses/by-sa/4.0/

The build step only filters malformed/non-word entries, preserves source order, and truncates to 5,000 rows. Each row is `value<TAB>count`.

## Phrase presets

`*.phrases.tsv` contains the first 1,000 short reusable subtitle utterances selected, in source frequency order, from **orgtre/top-open-subtitles-sentences** at commit `861f4267cdbb36f4cca4ddfdb2221f1c75bf485b`.

- Upstream: https://github.com/orgtre/top-open-subtitles-sentences
- Corpus origin: OpenSubtitles2018 / OPUS
- The upstream project states that its sentence/word lists carry the same terms as the underlying corpus; its generator code is CC BY 3.0.
- This project does not relicense those lists. Preserve the upstream attribution/corpus notice when redistributing them.

The build step keeps utterances with 2–8 lexical segments (using `Intl.Segmenter`), excludes overlong lines, preserves source frequency order, and truncates to 1,000 rows. Each row is `value<TAB>count`.

## Word meanings (Top-word decks)

`*.glosses.tsv` gives a short meaning, and for Japanese and Chinese a reading, for the words in `*.words.tsv`, so the Top 100 / 1,000 / 5,000 decks can be studied as two-sided cards. Rows are `rank<TAB>word<TAB>dictionary form<TAB>reading<TAB>meaning`; words with no meaning found are left out. Meanings are in English, except `en.glosses.tsv` (Spanish). Built by `scripts/build-glosses.mjs` from:

- **WikDict** bilingual dictionaries (derived from Wiktionary), ES/FR/DE/IT/PT/RU/NL/PL/TR → EN and EN → ES: https://www.wikdict.com, **CC BY-SA 3.0** (https://creativecommons.org/licenses/by-sa/3.0/)
- **lemmatization-lists** by Michal Měchura (inflected form → dictionary form for ES/FR/DE/IT/PT/RU/EN): https://github.com/michmech/lemmatization-lists, **ODbL 1.0** (https://opendatacommons.org/licenses/odbl/1-0/)
- **JMdict** by the Electronic Dictionary Research and Development Group, via jmdict-simplified (Japanese): https://www.edrdg.org/jmdict/j_jmdict.html, **CC BY-SA 4.0** (EDRDG licence: https://www.edrdg.org/edrdg/licence.html)
- **CC-CEDICT** (Chinese, readings in pinyin): https://cc-cedict.org, **CC BY-SA 4.0**
- **kengdic** (Korean): https://github.com/garfieldnate/kengdic, **MPL 2.0** / LGPL 2.0+

The build selects one primary sense per word and, for inflected forms, uses the dictionary form's meaning. Historical rows may contain additional senses; preset decks select the primary sense at load time. Common English → Spanish entries use the curated corrections in `vocabulary-meanings.js`.

This notice intentionally distinguishes the licenses of application code from the licenses/terms of bundled data.
