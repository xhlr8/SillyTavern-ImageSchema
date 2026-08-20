import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchImageResource, pluginImageUrl } from './index.js';
import {
    DEFAULT_SETTINGS,
    buildInstruction,
    normalizeRequest,
    normalizeSettings,
    parseMessage,
    parseVirtualSource,
    projectSchemas,
    replaceSchemaOccurrence,
} from './parser.js';

function settings(overrides = {}) {
    return normalizeSettings({
        ...structuredClone(DEFAULT_SETTINGS),
        ...overrides,
        defaults: { ...DEFAULT_SETTINGS.defaults, ...(overrides.defaults || {}) },
        parameterPolicies: { ...DEFAULT_SETTINGS.parameterPolicies, ...(overrides.parameterPolicies || {}) },
        allowedOverrides: overrides.allowedOverrides,
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

test('ignored overrides are silently omitted and fixed overrides are rejected', () => {
    assert.deepEqual(parseVirtualSource('/image/test?backend=secret-profile', settings()), { text: 'test', params: {} });
    assert.throws(() => parseVirtualSource('/image/test?backend=secret-profile', settings({ parameterPolicies: { backend: 'fixed' }, defaults: { backend: 'safe' } })), /fixed/);
});

test('defaults merge before overrides and canonicalize values', () => {
    const request = normalizeRequest(' prompt ', { f: 'PNG', t: '1.2' }, settings({
        defaults: { backend: 'gemini', image_size: '1k' },
        parameterPolicies: { backend: 'fixed', image_size: 'fixed', temperature: 'allow' },
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

test('replacing an inline schema persists a fresh seed in the canonical message', () => {
    const config = settings({ schema: 'inline' });
    const source = '<div><img class="portrait" src="/image/person?seed=42&ar=3%3A4"></div>';
    const updated = replaceSchemaOccurrence(source, 0, {
        text: 'person',
        params: { seed: 99, aspect_ratio: '3:4' },
    }, config);
    assert.match(updated, /class="portrait"/);
    assert.match(updated, /seed=99/);
    assert.doesNotMatch(updated, /seed=42/);
    assert.deepEqual(parseMessage(updated, config)[0].request.params, { seed: 99, aspect_ratio: '3:4' });
});

test('same seeded schema keeps the same projected request across reloads', () => {
    const config = settings({ schema: 'inline' });
    const source = '<img src="/image/person?seed=42">';
    const first = projectSchemas(source, config);
    const reloaded = projectSchemas(source, config);
    assert.deepEqual(first.occurrences[0].request, reloaded.occurrences[0].request);
    assert.equal(first.occurrences[0].key, reloaded.occurrences[0].key);
});

test('projection keys preserve exact image order and reject stale subsets', () => {
    const config = settings({ schema: 'delimiter' });
    const original = projectSchemas('<image>one</image><image>two</image>', config);
    const reduced = projectSchemas('<image>two</image>', config);
    const expectedKeys = reduced.occurrences.map(item => item.key);
    const renderedKeys = original.occurrences.map(item => item.key);
    assert.notDeepEqual(expectedKeys, renderedKeys);
    assert.equal(
        expectedKeys.length === renderedKeys.length && expectedKeys.every((key, index) => key === renderedKeys[index]),
        false,
    );
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

test('per-profile instruction templates place the schema prompt at schemaprompt', () => {
    const instruction = buildInstruction(settings(), 'Before profile guidance\n{{schemaprompt}}\nAfter profile guidance');
    assert.match(instruction, /^Before profile guidance/);
    assert.match(instruction, /literal & separators/);
    assert.match(instruction, /After profile guidance$/);
    assert.doesNotMatch(instruction, /\{\{schemaprompt\}\}/);
});

test('per-profile instructions without schemaprompt append the global schema prompt', () => {
    const instruction = buildInstruction(settings(), 'Use one image schema only.');
    assert.match(instruction, /^Use one image schema only\./);
    assert.match(instruction, /literal & separators/);
});

test('profile templates expand only schemaprompt and preserve SillyTavern macros', () => {
    const instruction = buildInstruction(settings({ useCustomInstruction: true, customInstruction: 'CUSTOM {{char}}' }), 'PROFILE {{user}}\n{{schemaprompt}}');
    assert.equal(instruction, 'PROFILE {{user}}\nCUSTOM {{char}}');
});

test('status-aware image fetch exposes cache, error, and fallback provenance headers', async () => {
    const body = new Blob(['svg'], { type: 'image/svg+xml' });
    const result = await fetchImageResource('/image/test', async (source, options) => {
        assert.equal(source, '/image/test');
        assert.equal(options.credentials, 'same-origin');
        return new Response(body, {
            status: 200,
            headers: {
                'X-Image-Cache': 'ERROR',
                'X-Image-Error': 'upstream_error',
                'X-Image-Profile': 'fallback',
                'X-Image-Requested-Profile': 'primary',
                'X-Image-Fallback-Reason': 'connection_error',
            },
        });
    });
    assert.equal(result.errorCode, 'upstream_error');
    assert.equal(result.cache, 'ERROR');
    assert.equal(result.profile, 'fallback');
    assert.equal(result.requestedProfile, 'primary');
    assert.equal(result.fallbackReason, 'connection_error');
    assert.equal(await result.blob.text(), 'svg');
});

test('status-aware image fetch preserves useful non-image errors', async () => {
    await assert.rejects(fetchImageResource('/image/test', async () => new Response('invalid_profile: missing', {
        status: 400,
        statusText: 'Bad Request',
    })), /400 Bad Request: invalid_profile: missing/);
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
