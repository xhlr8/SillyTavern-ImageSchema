import assert from 'node:assert/strict';
import test from 'node:test';

import {
    MAX_IMAGE_SEED,
    formatEffectiveRequest,
    parseStoredImageRequest,
    withFreshSeed,
    withRefreshToken,
} from './image-ui.js';

test('withFreshSeed copies the request and preserves its other parameters', () => {
    const request = { text: 'portrait', params: { width: 512, seed: 9 } };
    const result = withFreshSeed(request, () => 0.5);

    assert.deepEqual(result, {
        text: 'portrait',
        params: { width: 512, seed: 1073741824 },
    });
    assert.deepEqual(request, { text: 'portrait', params: { width: 512, seed: 9 } });
    assert.notStrictEqual(result.params, request.params);
});

test('withFreshSeed clamps random samples to the supported seed range', () => {
    assert.equal(withFreshSeed({ text: 'a', params: {} }, () => -1).params.seed, 0);
    assert.equal(withFreshSeed({ text: 'a', params: {} }, () => 1).params.seed, MAX_IMAGE_SEED);
    assert.equal(withFreshSeed({ text: 'a', params: {} }, () => Number.NaN).params.seed, 0);
});

test('parseStoredImageRequest accepts only the expected request shape', () => {
    assert.deepEqual(
        parseStoredImageRequest('{"text":"a","params":{"seed":2}}'),
        { text: 'a', params: { seed: 2 } },
    );
    assert.equal(parseStoredImageRequest('not json'), null);
    assert.equal(parseStoredImageRequest('{"text":"a","params":[]}'), null);
    assert.equal(parseStoredImageRequest('{"text":2,"params":{}}'), null);
});

test('withRefreshToken preserves query delimiters and encodes tokens', () => {
    assert.equal(withRefreshToken('/image/a', 'x y'), '/image/a?_refresh=x%20y');
    assert.equal(withRefreshToken('/image/a?seed=1', 2), '/image/a?seed=1&_refresh=2');
});

test('formatEffectiveRequest produces readable JSON', () => {
    assert.equal(
        formatEffectiveRequest({ text: 'a', params: { seed: 1 } }),
        '{\n  "text": "a",\n  "params": {\n    "seed": 1\n  }\n}',
    );
});
