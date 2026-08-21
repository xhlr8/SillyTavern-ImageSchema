import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    MAX_IMAGE_SEED,
    activeSwipeKey,
    formatEffectiveRequest,
    getImagePin,
    setImagePin,
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

test('image pins are isolated by active swipe and mirrored into swipe metadata', () => {
    const message = { extra: {}, swipe_id: 1, swipes: ['a', 'b'], swipe_info: [{ extra: {} }, { extra: {} }] };
    assert.equal(activeSwipeKey(message), 'swipe:1');
    setImagePin(message, 0, { outputId: 'abc', request: { text: 'cat', params: { seed: 42 } } });
    assert.equal(getImagePin(message, 0).outputId, 'abc');
    assert.equal(message.swipe_info[1].extra.image_schema_outputs['swipe:1'][0].outputId, 'abc');
    message.swipe_id = 0;
    assert.equal(getImagePin(message, 0), null);
    setImagePin(message, 0, { outputId: 'def', request: { text: 'dog', params: { seed: 9 } } });
    assert.equal(getImagePin(message, 0).outputId, 'def');
    message.swipe_id = 1;
    assert.equal(getImagePin(message, 0).outputId, 'abc');
});

test('withRefreshToken preserves query delimiters and encodes tokens', () => {
    assert.equal(withRefreshToken('/image/a', 'x y'), '/image/a?_refresh=x%20y');
    assert.equal(withRefreshToken('/image/a?seed=1', 2), '/image/a?seed=1&_refresh=2');
});

test('settings use five flat areas and exactly two internal disclosures', () => {
    const html = readFileSync(new URL('./settings.html', import.meta.url), 'utf8');
    assert.equal((html.match(/class="[^"]*image-schema-area(?:\s|")/g) || []).length, 5);
    assert.equal((html.match(/<details\b/g) || []).length, 2);
    assert.match(html, /ComfyUI workflow &amp; bindings/);
    assert.match(html, /id="image_schema_fallback_options"/);
    assert.match(html, /id="image_schema_inject_options"/);
    assert.match(html, /id="image_schema_custom_instruction_field"/);
    assert.doesNotMatch(html, /image_schema_provider_make_default/);
    assert.equal((html.match(/id="image_schema_provider_set_default"/g) || []).length, 1);
});

test('formatEffectiveRequest produces readable JSON', () => {
    assert.equal(
        formatEffectiveRequest({ text: 'a', params: { seed: 1 } }),
        '{\n  "text": "a",\n  "params": {\n    "seed": 1\n  }\n}',
    );
});
