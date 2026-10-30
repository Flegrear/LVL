import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEmbeddedChapterMarkers } from '../shared/media/embedded-chapter-markers.js';

const duration = 1440;
const empty = { intro: null, outro: null };
const chapter = (title, start, end) => ({
  id: 1, start_time: String(start), end_time: String(end), tags: { title },
});
const marker = (start, end) => ({
  start_ms: start * 1000, end_ms: end * 1000,
  match: 'exact', confidence: 1, source: 'embedded-chapter',
});

test('extracts explicit same-file FFprobe MKV OP/ED, with milliseconds and source provenance', () => {
  const chapters = [
    chapter('Prologue', 0, 50),
    chapter('OP', 50, 140),
    chapter('Act 1', 140, 1300),
    chapter('ED', 1300, 1390),
    chapter('Epilogue', 1390, 1440),
  ];
  const snapshot = structuredClone(chapters);
  assert.deepEqual(normalizeEmbeddedChapterMarkers(chapters, duration), {
    intro: marker(50, 140), outro: marker(1300, 1390),
  });
  assert.deepEqual(chapters, snapshot, 'normalizing does not modify media probe metadata');
});

test('all exact permitted aliases are accepted case-insensitively, with optional whitespace', () => {
  for (const name of ['OP', 'Opening', 'Intro']) {
    const result = normalizeEmbeddedChapterMarkers([chapter(` ${name.toLowerCase()} `, 60, 150)], duration);
    assert.deepEqual(result, { intro: marker(60, 150), outro: null }, name);
  }
  for (const name of ['ED', 'Ending', 'Outro', 'Credits']) {
    const result = normalizeEmbeddedChapterMarkers([chapter(name.toUpperCase(), 1300, 1400)], duration);
    assert.deepEqual(result, { intro: null, outro: marker(1300, 1400) }, name);
  }
  const directTitle = [{ title: 'Opening', start_time: 60, end_time: 150 }];
  assert.deepEqual(normalizeEmbeddedChapterMarkers(directTitle, duration).intro, marker(60, 150));
  const uppercaseTag = [{ tags: { TITLE: 'Credits' }, start_time: '1300.000000', end_time: '1400.000000' }];
  assert.deepEqual(normalizeEmbeddedChapterMarkers(uppercaseTag, duration).outro, marker(1300, 1400));
});

test('no partial names, numbered chapters, season heuristics, missing opposite segment or guessed times', () => {
  for (const name of ['OP 1', 'Opening theme', 'Intro:', 'Intro (0:30)', 'ED 2', 'Ending Credits',
    'Chapter 01', 'Chapter 03 - OP', 'Opening/Ending', 'Next Episode', 'Commercials']) {
    assert.deepEqual(normalizeEmbeddedChapterMarkers([chapter(name, 80, 150)], duration), empty, name);
  }
  assert.deepEqual(normalizeEmbeddedChapterMarkers([chapter('Act One', 0, duration)], duration), empty);
  assert.deepEqual(normalizeEmbeddedChapterMarkers([], duration), empty);
  assert.deepEqual(normalizeEmbeddedChapterMarkers(null, duration), empty);
});

test('never uses a missing end, an invalid start or numeric coercion to invent a marker', () => {
  for (const [start, end] of [
    [60, undefined], [undefined, 150], ['', 150], [null, 150], ['NaN', 150],
    [60, 'Infinity'], [60, '2e2'], ['0x3c', 150], ['00:01:00', 150],
    [-10, 150], [150, 150], [160, 150], [60, -150], [60, 1441],
  ]) {
    assert.deepEqual(normalizeEmbeddedChapterMarkers([{
      tags: { title: 'OP' }, start_time: start, end_time: end,
    }], duration), empty, `${start} to ${end}`);
  }
  for (const badDuration of [null, undefined, '', 0, -1, 'NaN', 'Infinity', '24:00', 86401]) {
    assert.deepEqual(normalizeEmbeddedChapterMarkers([chapter('OP', 60, 150)], badDuration), empty,
      `invalid duration ${badDuration}`);
  }
});

test('out-of-position, short or clipped segment is rejected; other valid kind stays independently usable', () => {
  for (const [name, start, end] of [
    ['OP', 700, 770], ['OP', 550, 800], ['Intro', 100, 103],
    ['ED', 700, 810], ['Ending', 1438, 1440],
  ]) assert.deepEqual(normalizeEmbeddedChapterMarkers([chapter(name, start, end)], duration), empty);
  assert.deepEqual(normalizeEmbeddedChapterMarkers([
    chapter('OP', 100, 103), chapter('Ending', 1280, 1390),
  ], duration), { intro: null, outro: marker(1280, 1390) });
});

test('duplicate marker labels and conflicting title fields fail closed', () => {
  assert.deepEqual(normalizeEmbeddedChapterMarkers([
    chapter('OP', 50, 70), chapter('Intro', 70, 150), chapter('ED', 1300, 1390),
  ], duration), empty, 'two openings are not arbitrarily merged or selected');
  assert.deepEqual(normalizeEmbeddedChapterMarkers([
    { title: 'Opening', tags: { title: 'Ending' }, start_time: 50, end_time: 150 },
  ], duration), empty);
  assert.deepEqual(normalizeEmbeddedChapterMarkers([
    { tags: { title: ['OP'] }, start_time: 50, end_time: 150 },
  ], duration), empty);
});

test('overlap with an ordinary chapter or the opposite marker cannot authorize either overlapping region', () => {
  assert.deepEqual(normalizeEmbeddedChapterMarkers([
    chapter('Opening', 50, 150), chapter('Scene', 100, 200),
  ], duration), empty);
  assert.deepEqual(normalizeEmbeddedChapterMarkers([
    chapter('Opening', 550, 710), chapter('ED', 690, 830),
  ], duration), empty);
  assert.deepEqual(normalizeEmbeddedChapterMarkers([
    chapter('Scene', 0, 1300), chapter('Ending', 1300, 1390),
  ], duration), { intro: null, outro: marker(1300, 1390) }, 'touching boundaries are safe');
});

test('malformed generic chapters, excessive chapter counts and overlong labels cannot obscure conflicts', () => {
  assert.deepEqual(normalizeEmbeddedChapterMarkers([
    chapter('OP', 50, 150), { tags: { title: 'Scene' }, start_time: 100 },
  ], duration), empty);
  assert.deepEqual(normalizeEmbeddedChapterMarkers([
    chapter('Opening', 50, 150), chapter('Scene', 150, 1441),
  ], duration), empty);
  assert.deepEqual(normalizeEmbeddedChapterMarkers([chapter('OP', 50, 150),
    ...Array.from({ length: 512 }, (_, i) => chapter('Scene', 200 + i, 201 + i))], duration), empty);
  assert.deepEqual(normalizeEmbeddedChapterMarkers([chapter('OP'.repeat(50), 50, 150)], duration), empty);
});

test('one file cannot leak a marker into subsequent, unmarked or different-duration files', () => {
  const first = normalizeEmbeddedChapterMarkers([chapter('Opening', 60, 150)], duration);
  const next = normalizeEmbeddedChapterMarkers([chapter('Part One', 0, 200)], 200);
  assert.deepEqual(first.intro, marker(60, 150));
  assert.deepEqual(next, empty);
  assert.deepEqual(normalizeEmbeddedChapterMarkers([chapter('Opening', 60, 150)], 120), empty,
    'a marker is not reusable for a shorter alternate cut');
});
