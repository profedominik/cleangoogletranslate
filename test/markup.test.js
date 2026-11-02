import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TAGS, buildTagMap, parseLine, serializeLine, analyze, planLine, planSegments, assemble,
  planKey, protect, restore, splitProtected, hasTranslatable, highlight, remapLines, hash, mdInfo,
} from '../public/shared/markup.js';
import { normalizeLang, languageName } from '../public/shared/languages.js';
import { buildGtxUrl, parseGtx, planGtxBatches, splitJoined, toGoogleLang } from '../public/shared/gtx.js';

const tags = buildTagMap(DEFAULT_TAGS);

test('parseLine recognises known tags only (case-insensitive)', () => {
  assert.deepEqual(parseLine('[DIALOG]', tags), { tokens: [{ name: 'DIALOG', closing: false }], body: '', prefixLen: 8 });
  assert.deepEqual(parseLine('[grammar] Ser vs estar', tags).body, 'Ser vs estar');
  assert.equal(parseLine('[grammar] Ser vs estar', tags).tokens[0].name, 'GRAMMAR');
  assert.deepEqual(parseLine('[A] option one', tags), { tokens: [], body: '[A] option one', prefixLen: 0 });
  assert.deepEqual(parseLine('[/DIALOG]', tags).tokens, [{ name: 'DIALOG', closing: true }]);
  assert.deepEqual(parseLine('[/]', tags).tokens, [{ name: '', closing: true }]);
  const multi = parseLine('[VOCABULARY][NOTRANSLATE] perro', tags);
  assert.deepEqual(multi.tokens.map((t) => t.name), ['VOCABULARY', 'NOTRANSLATE']);
  assert.equal(multi.body, 'perro');
  // exactly one space is consumed, extra spaces stay in the body
  assert.equal(parseLine('[STORY]  indented', tags).body, ' indented');
});

test('serializeLine round-trips', () => {
  for (const s of ['[DIALOG]', '[GRAMMAR] text', '[VOCABULARY][NOTRANSLATE] perro', '[/]', 'plain', '[STORY]  x']) {
    const p = parseLine(s, tags);
    assert.equal(serializeLine(p.tokens, p.body), s);
  }
});

test('analyze: sections, spans, closers, inline tags', () => {
  const lines = [
    'Title',                 // 0 text
    '[DIALOG]',              // 1 open
    'Ana: Hola',             // 2 in dialog
    '[NOTRANSLATE]',         // 3 open span
    'Juan Pérez',            // 4 dialog + notranslate
    '[/NOTRANSLATE]',        // 5 close span
    'Juan: ¿Qué tal?',       // 6 dialog
    '',                      // 7 empty in dialog
    '[VOCABULARY]',          // 8 new section closes dialog
    'perro - dog',           // 9 vocab
    '[/VOCABULARY]',         // 10 close
    '[GRAMMAR] Inline rule', // 11 inline
    '[/STORY]',              // 12 orphan closer
  ];
  const a = analyze(lines, tags);
  assert.equal(a[0].role, 'text');
  assert.equal(a[0].section, null);
  assert.equal(a[1].role, 'open');
  assert.equal(a[1].section, 'DIALOG');
  assert.equal(a[2].section, 'DIALOG');
  assert.equal(a[2].style, 'dialog');
  assert.equal(a[2].translate, true);
  assert.equal(a[3].role, 'open');
  assert.deepEqual(a[4].spans, ['NOTRANSLATE']);
  assert.equal(a[4].translate, false);
  assert.equal(a[5].role, 'close');
  assert.deepEqual(a[5].spans, ['NOTRANSLATE']);
  assert.deepEqual(a[6].spans, []);
  assert.equal(a[6].translate, true);
  assert.equal(a[7].role, 'empty');
  assert.equal(a[7].section, 'DIALOG');
  assert.equal(a[8].section, 'VOCABULARY');
  assert.equal(a[9].style, 'vocab');
  assert.equal(a[10].role, 'close');
  assert.equal(a[10].section, 'VOCABULARY');
  assert.equal(a[11].role, 'inline');
  assert.equal(a[11].section, null);
  assert.deepEqual(a[11].inline, ['GRAMMAR']);
  assert.equal(a[11].style, 'grammar');
  assert.equal(a[12].orphan, true);
});

test('analyze: span closes at section boundary, [/] closes innermost', () => {
  const a = analyze(['[STORY]', '[NOTRANSLATE]', 'x', '[/]', 'y', '[/]', 'z'], tags);
  assert.equal(a[2].translate, false);
  assert.equal(a[4].translate, true);
  assert.equal(a[4].section, 'STORY');
  assert.equal(a[6].section, null);
  const b = analyze(['[NOTRANSLATE]', 'a', '[DIALOG]', 'b'], tags);
  assert.equal(b[1].translate, false);
  assert.equal(b[3].translate, true, 'section opener ends the span');
});

test('planLine: markers, copy, md prefixes, dialog speakers, tables', () => {
  const info = (lines) => analyze(lines, tags);
  assert.equal(planLine(info(['[DIALOG]'])[0]).mode, 'none');
  assert.equal(planLine(info([''])[0]).mode, 'none');
  assert.equal(planLine(info(['[NOTRANSLATE] Juan'])[0]).mode, 'copy');
  assert.equal(planLine(info(['12345'])[0]).mode, 'copy');
  assert.equal(planLine(info(['---'])[0]).mode, 'copy');

  const h = planLine(info(['## Hello world'])[0]);
  assert.deepEqual(h.parts, [{ keep: '## ' }, { tr: 'Hello world' }]);

  const d = analyze(['[DIALOG]', 'Ana: Hello, how are you?', '1. Tom: Fine!'], tags);
  assert.deepEqual(planLine(d[1]).parts, [{ keep: 'Ana: ' }, { tr: 'Hello, how are you?' }]);
  assert.deepEqual(planLine(d[2]).parts, [{ keep: '1. Tom: ' }, { tr: 'Fine!' }]);

  const t = analyze(['[TABLE]', '| Word | Meaning | 3 |'], tags);
  const tp = planLine(t[1]);
  assert.deepEqual(planSegments(tp), ['Word', 'Meaning']);
  assert.equal(assemble(tp, ['Palabra', 'Significado']), '| Palabra | Significado | 3 |');

  // dialog speaker heuristics: questions are not speakers
  const q = analyze(['[DIALOG]', 'Why? Because: reasons'], tags);
  assert.deepEqual(planSegments(planLine(q[1])), ['Why? Because: reasons']);
});

test('planKey changes with text and target, not with unrelated state', () => {
  const p1 = planLine(analyze(['Hello'], tags)[0]);
  const p2 = planLine(analyze(['Hello!'], tags)[0]);
  assert.notEqual(planKey(p1, 'en', 'es'), planKey(p2, 'en', 'es'));
  assert.notEqual(planKey(p1, 'en', 'es'), planKey(p1, 'en', 'de'));
  assert.equal(planKey(p1, 'en', 'es'), planKey(planLine(analyze(['Hello'], tags)[0]), 'en', 'es'));
});

test('protect / restore placeholders', () => {
  const p = protect('Say `hola` to {{name}} at https://example.com/x. Fill ____ please {0}');
  assert.equal(p.text, 'Say {0} to {1} at {2}. Fill {3} please {4}');
  assert.equal(p.slots.length, 5);
  assert.equal(restore('Di {0} a {1} en {2}. Rellena {3} por favor {4}', p.slots),
    'Di `hola` a {{name}} en https://example.com/x. Rellena ____ por favor {0}');
  assert.equal(restore('Di { 0 } a {1} en {2}. {3} {4}', p.slots).startsWith('Di `hola`'), true);
  assert.equal(restore('Di {0} a {1} en {2}.', p.slots), null, 'missing placeholder -> null');
  assert.equal(restore('{0}{0}{1}{2}{3}{4}', p.slots), null, 'duplicated placeholder -> null');
  assert.equal(restore('plain', []), 'plain');
  assert.deepEqual(splitProtected('a `b` c').map((x) => x.protected), [false, true, false]);
  assert.equal(hasTranslatable('{0} {1}'), false);
  assert.equal(hasTranslatable('{0} hola'), true);
});

test('highlight runs cover the body exactly', () => {
  const samples = [
    ['Ana: Hola `tú` ____', 'dialog'],
    ['perro - dog', 'vocab'],
    ['| a | b |', 'table'],
    ['# Heading https://x.org', 'none'],
    ['', 'none'],
  ];
  for (const [s, style] of samples) {
    const runs = highlight(s, style);
    assert.equal(runs.map((r) => r[0]).join(''), s);
  }
  const r = highlight('Ana: Hola `tú`', 'dialog');
  assert.deepEqual(r[0], ['Ana: ', 'speaker']);
  assert.deepEqual(r[r.length - 1], ['`tú`', 'code']);
  assert.deepEqual(highlight('perro - dog', 'vocab').map((x) => x[1]), ['term', 'sep', '']);
});

test('mdInfo', () => {
  assert.equal(mdInfo('### Title').heading, 3);
  assert.equal(mdInfo('> quote').quote, true);
  assert.equal(mdInfo('- item').list, true);
  assert.equal(mdInfo('***').hr, true);
  assert.equal(mdInfo('plain').prefix, '');
});

test('remapLines keeps ids of unchanged lines', () => {
  const old = ['a', 'b', 'c', 'd'].map((text, i) => ({ id: `id${i}`, text }));
  const res = remapLines(old, ['a', 'x', 'c', 'd', 'b']);
  assert.deepEqual(res.map((r) => r.from?.id ?? null), ['id0', null, 'id2', 'id3', 'id1']);
  const res2 = remapLines(old, []);
  assert.equal(res2.length, 0);
});

test('hash is stable', () => {
  assert.equal(hash('hello'), hash('hello'));
  assert.notEqual(hash('hello'), hash('hellp'));
});

test('languages normalisation', () => {
  assert.equal(normalizeLang('iw'), 'he');
  assert.equal(normalizeLang('zh-Hans'), 'zh-CN');
  assert.equal(normalizeLang('pt-BR'), 'pt');
  assert.equal(normalizeLang('EN'), 'en');
  assert.equal(normalizeLang(''), 'auto');
  assert.equal(normalizeLang('xx-unknown'), null);
  assert.equal(normalizeLang('auto', { allowAuto: false }), null);
  assert.equal(languageName('de'), 'German');
});

test('gtx helpers', () => {
  const url = buildGtxUrl('Hello world', 'auto', 'he');
  assert.match(url, /client=gtx/);
  assert.match(url, /tl=iw/);
  assert.equal(toGoogleLang('jv'), 'jw');
  // real response captured from translate.googleapis.com
  const sample = [[['Hola Mundo. ', 'Hello world. ', null, null, 10], ['¿Cómo estás?\n', 'How are you?\n', null, null, 12], ['Esta es la línea dos.', 'This is line two.', null, null, 3]], null, 'en'];
  const parsed = parseGtx(sample);
  assert.equal(parsed.text, 'Hola Mundo. ¿Cómo estás?\nEsta es la línea dos.');
  assert.equal(parsed.detected, 'en');
  assert.deepEqual(splitJoined(parsed.text, 2), ['Hola Mundo. ¿Cómo estás?', 'Esta es la línea dos.']);
  assert.equal(splitJoined(parsed.text, 3), null);
  const batches = planGtxBatches(['a', 'b\nc', 'x'.repeat(5000), 'd', 'e'], 1000);
  assert.deepEqual(batches, [[0], [1], [2], [3, 4]]);
  assert.throws(() => parseGtx('<html>'));
});
