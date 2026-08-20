import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildInstruction,
    normalizeSettings,
    parseMessage,
    parseVirtualSource,
    projectSchemas,
} from '../parser.js';

function settings(overrides = {}) {
    return normalizeSettings({
        parameterPolicies: {
            seed: 'allow',
            aspect_ratio: 'allow',
            image_size: 'allow',
            output_format: 'allow',
            negative: 'allow',
        },
        ...overrides,
    });
}

test('inline schema parses encoded prompt and standard query separators', () => {
    const result = parseMessage('<img src="/image/a%20silver-haired%20girl?ar=3%3A4&s=1K&seed=42">', settings());
    assert.equal(result.length, 1);
    assert.equal(result[0].request.text, 'a silver-haired girl');
    assert.deepEqual(result[0].request.params, { seed: 42, aspect_ratio: '3:4', image_size: '1K' });
});

test('inline schema accepts HTML-serialized ampersands', () => {
    const result = parseVirtualSource('/image/cat?ar=1%3A1&amp;seed=7', settings());
    assert.equal(result.text, 'cat');
    assert.equal(result.params.aspect_ratio, '1:1');
    assert.equal(result.params.seed, 7);
});

test('inline schema ignores disabled model overrides and rejects fixed ones', () => {
    assert.deepEqual(parseVirtualSource('/image/cat?b=openai', settings()), { text: 'cat', params: {} });
    assert.throws(() => parseVirtualSource('/image/cat?b=openai', settings({
        parameterPolicies: { backend: 'fixed' },
        defaults: { backend: 'safe' },
    })), /fixed/);
});

test('delimiter schema extracts text only and applies configured defaults', () => {
    const result = parseMessage('[IMG]a cat[/IMG]', settings({
        schema: 'delimiter',
        delimiterOpen: '[IMG]',
        delimiterClose: '[/IMG]',
        defaults: { aspect_ratio: '4:3' },
    }));
    assert.equal(result[0].request.text, 'a cat');
    assert.deepEqual(result[0].request.params, { aspect_ratio: '4:3' });
});

test('JSON schema requires both text and params', () => {
    const valid = parseMessage('<image>{"text":"cat","params":{"seed":3}}</image>', settings({ schema: 'json' }));
    assert.equal(valid[0].request.params.seed, 3);
    const invalid = parseMessage('<image>{"text":"cat"}</image>', settings({ schema: 'json' }));
    assert.match(invalid[0].error, /requires text and params/);
});

test('incomplete streamed delimiter is not parsed', () => {
    assert.deepEqual(parseMessage('<image>{"text":"cat"', settings({ schema: 'json' })), []);
});

test('schemas inside code fences are ignored', () => {
    const source = '```html\n<img src="/image/cat?seed=2">\n```';
    assert.deepEqual(parseMessage(source, settings()), []);
});

test('multiple delimiter schemas project to image tags', () => {
    const projected = projectSchemas('A <image>cat</image> B <image>dog</image>', settings({ schema: 'delimiter' }));
    assert.equal(projected.occurrences.length, 2);
    assert.match(projected.text, /<img src="\/image\/cat"/);
    assert.match(projected.text, /<img src="\/image\/dog"/);
});

test('generated instructions use literal ampersand separators and no plugin route', () => {
    const instruction = buildInstruction(settings());
    assert.match(instruction, /literal & separators/);
    assert.doesNotMatch(instruction, /api\/plugins/);
    assert.doesNotMatch(instruction, /&amp;/);
});

test('id is not a recognized model parameter', () => {
    assert.throws(() => parseVirtualSource('/image/cat?id=portrait', settings()), /unknown image parameter: id/);
});
