import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginImageUrl } from './index.js';
import {
    DEFAULT_SETTINGS,
    buildInstruction,
    normalizeRequest,
    normalizeSettings,
    parseMessage,
    parseVirtualSource,
    projectSchemas,
} from './parser.js';

function settings(overrides = {}) {
    return normalizeSettings({
        ...structuredClone(DEFAULT_SETTINGS),
        ...overrides,
        defaults: { ...DEFAULT_SETTINGS.defaults, ...(overrides.defaults || {}) },
        allowedOverrides: { ...DEFAULT_SETTINGS.allowedOverrides, ...(overrides.allowedOverrides || {}) },
    });
}

test('inline schema decodes Unicode and standard query parameters', () => {
    const source = '<img class="wide" src="/image/%E9%8A%80%E9%AB%AA%20girl?ar=3%3A4&amp;s=1k&seed=42">';
    const [match] = parseMessage(source, settings());
    assert.equal(match.request.text, '銀髪 girl');
    assert.deepEqual(match.request.params, { seed: 42, aspect_ratio: '3:4', image_size: '1K' });
});

test('inline parser supports multiple images and preserves nonvirtual images', () => {
    const source = '<img src="/image/one"><img src="https://example.com/x.png"><img src="/image/two?seed=2">';
    const matches = parseMessage(source, settings());
    assert.equal(matches.length, 2);
    assert.equal(matches[0].request.text, 'one');
    assert.equal(matches[1].request.text, 'two');
});

test('inline parser reports malformed URL escapes', () => {
    const [match] = parseMessage('<img src="/image/bad%ZZ">', settings());
    assert.match(match.error, /malformed URL encoding/);
});

test('inline parser rejects conflicting aliases and id parameter', () => {
    assert.throws(() => parseVirtualSource('/image/test?ar=3:4&aspect_ratio=16:9', settings()), /conflicting aliases/);
    assert.throws(() => parseVirtualSource('/image/test?id=separate-id', settings()), /unknown image parameter: id/);
});

test('disallowed override is rejected', () => {
    assert.throws(() => parseVirtualSource('/image/test?backend=secret-profile', settings()), /not allowed/);
});

test('defaults merge before overrides and canonicalize values', () => {
    const request = normalizeRequest(' prompt ', { f: 'PNG', t: '1.2' }, settings({
        defaults: { backend: 'gemini', image_size: '1k' },
        allowedOverrides: { temperature: true },
    }));
    assert.deepEqual(request, {
        text: 'prompt',
        params: { backend: 'gemini', image_size: '1K', output_format: 'image/png', temperature: 1.2 },
    });
});

test('JSON wrapper requires text and params, including empty params', () => {
    const cfg = settings({ schema: 'json' });
    const good = parseMessage('<image>{"text":"one","params":{}}</image>', cfg);
    assert.equal(good[0].request.text, 'one');
    const missing = parseMessage('<image>{"text":"one"}</image>', cfg);
    assert.match(missing[0].error, /requires text and params/);
    const badParams = parseMessage('<image>{"text":"one","params":[]}</image>', cfg);
    assert.match(badParams[0].error, /params must be a plain object/);
});

test('JSON wrapper supports custom property names and multiple blocks', () => {
    const cfg = settings({ schema: 'json', jsonTextProperty: 'prompt', jsonParamsProperty: 'options' });
    const source = '<image>{"prompt":"one","options":{}}</image> words <image>{"prompt":"two","options":{"seed":9}}</image>';
    const matches = parseMessage(source, cfg);
    assert.equal(matches.length, 2);
    assert.equal(matches[1].request.params.seed, 9);
});

test('delimiter mode handles repeated blocks and does not accept params', () => {
    const cfg = settings({ schema: 'delimiter', delimiterOpen: '[IMAGE]', delimiterClose: '[/IMAGE]', defaults: { seed: '5' } });
    const matches = parseMessage('[IMAGE]one[/IMAGE] x [IMAGE]two[/IMAGE]', cfg);
    assert.deepEqual(matches.map(x => x.request.text), ['one', 'two']);
    assert.equal(matches[0].request.params.seed, 5);
});

test('incomplete and nested delimiter output is handled deterministically', () => {
    const cfg = settings({ schema: 'delimiter', delimiterOpen: '<image>', delimiterClose: '</image>' });
    assert.equal(parseMessage('<image>streaming', cfg).length, 0);
    const [nested] = parseMessage('<image>outer <image>inner</image> tail</image>', cfg);
    assert.equal(nested.request.text, 'outer <image>inner');
});

test('schemas in code blocks can be ignored', () => {
    const cfg = settings({ schema: 'delimiter', delimiterOpen: '[IMAGE]', delimiterClose: '[/IMAGE]', ignoreCodeBlocks: true });
    const source = '```\n[IMAGE]not this[/IMAGE]\n```\n[IMAGE]this[/IMAGE]';
    assert.deepEqual(parseMessage(source, cfg).map(x => x.request.text), ['this']);
});

test('projection converts JSON wrappers without mutating original text', () => {
    const source = 'Before <image>{"text":"a & b","params":{}}</image> After';
    const result = projectSchemas(source, settings({ schema: 'json' }));
    assert.match(result.text, /<img src="\/image\/a%20%26%20b"/);
    assert.equal(source, 'Before <image>{"text":"a & b","params":{}}</image> After');
});

test('generated instruction exposes only the virtual path and documents literal ampersands', () => {
    const instruction = buildInstruction(settings());
    assert.match(instruction, /\/image\//);
    assert.match(instruction, /literal & separators/);
    assert.doesNotMatch(instruction, /api\/plugins|image-schema\/image/);
    assert.doesNotMatch(instruction, /\bid\b.*parameter/i);
});

test('custom instruction is used exactly', () => {
    assert.equal(buildInstruction(settings({ useCustomInstruction: true, customInstruction: 'CUSTOM' })), 'CUSTOM');
});

test('per-profile instruction appends to generated schema instruction with clear delimiters', () => {
    const instruction = buildInstruction(settings(), '  Use one image schema only.  ');
    assert.match(instruction, /literal & separators/);
    assert.match(instruction, /--- Per-profile image-schema instruction ---\nUse one image schema only\.\n--- End per-profile image-schema instruction ---$/);
});

test('per-profile instruction appends after a custom global instruction', () => {
    const instruction = buildInstruction(settings({ useCustomInstruction: true, customInstruction: 'CUSTOM' }), 'PROFILE');
    assert.equal(instruction, 'CUSTOM\n\n--- Per-profile image-schema instruction ---\nPROFILE\n--- End per-profile image-schema instruction ---');
});

test('plugin URL is hidden and maps normalized names to plugin contract', () => {
    const url = pluginImageUrl({
        text: 'a/b & c',
        params: {
            backend: 'gemini', seed: 4, output_format: 'image/png',
            aspect_ratio: '3:4', image_size: '1K',
        },
    });
    assert.match(url, /^\/api\/plugins\/image-schema\/image\/a%2Fb%20%26%20c\?/);
    assert.match(url, /profile=gemini/);
    assert.match(url, /outputFormat=image%2Fpng/);
    assert.match(url, /aspectRatio=3%3A4/);
    assert.match(url, /imageSize=1K/);
    assert.match(url, /seed=4/);
});
