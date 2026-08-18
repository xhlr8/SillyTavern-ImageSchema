import assert from 'node:assert/strict';
import test from 'node:test';

import {
    PROVIDER_ROUTE_PATHS,
    normalizeProviderConfig,
    normalizeProviderProfile,
    displayProviderUrl,
    resolveProviderUrl,
    parseAllowedModels,
    parseProviderDefaults,
    redactSensitiveValue,
} from './provider.js';

test('provider routes use the anticipated server contract', () => {
    assert.deepEqual(PROVIDER_ROUTE_PATHS, {
        config: '/providers/config',
        profileSave: '/providers/profile/save',
        profileDelete: '/providers/profile/delete',
        defaultProfile: '/providers/default',
        secret: '/providers/secret',
        profileTest: '/providers/profile/test',
    });
});

test('provider config accepts keyed profiles and secret status only', () => {
    const config = normalizeProviderConfig({
        defaultProfile: 'art',
        profiles: {
            art: {
                type: 'gemini-sse',
                url: 'https://example.invalid/generate',
                model: 'image-model',
                allowedModels: ['image-model', 'image-model'],
                timeout: 9000,
                hasApiKey: true,
            },
        },
    });
    assert.equal(config.defaultProfile, 'art');
    assert.deepEqual(config.profiles[0], {
        name: 'art',
        type: 'gemini-sse',
        url: 'https://example.invalid/generate',
        method: '',
        model: 'image-model',
        allowedModels: ['image-model'],
        timeoutMs: 9000,
        defaults: {},
        apiKeyConfigured: true,
    });
    assert.equal(Object.hasOwn(config.profiles[0], 'apiKey'), false);
});

test('generic profiles normalize method and safe defaults', () => {
    const profile = normalizeProviderProfile({ type: 'generic', method: 'post', allowedModels: 'one, two\none', defaults: { width: 512 } }, 'local');
    assert.equal(profile.name, 'local');
    assert.equal(profile.method, 'POST');
    assert.deepEqual(profile.allowedModels, ['one', 'two']);
    assert.deepEqual(profile.defaults, { width: 512 });
});

test('allowed models and defaults parsing validate user input', () => {
    assert.deepEqual(parseAllowedModels(' alpha\n beta,alpha '), ['alpha', 'beta']);
    assert.deepEqual(parseProviderDefaults(''), {});
    assert.deepEqual(parseProviderDefaults('{"size":"1024x1024"}'), { size: '1024x1024' });
    assert.throws(() => parseProviderDefaults('[]'), /JSON object/);
    assert.throws(() => parseProviderDefaults('{bad'), /valid JSON/);
});

test('OpenAI base URLs resolve to the generations endpoint without double-appending', () => {
    assert.equal(resolveProviderUrl('openai', 'https://example.test/openai-image'), 'https://example.test/openai-image/v1/images/generations');
    assert.equal(resolveProviderUrl('openai', 'https://example.test/openai-image/v1'), 'https://example.test/openai-image/v1/images/generations');
    assert.equal(resolveProviderUrl('openai', 'https://example.test/openai-image/v1/images/generations'), 'https://example.test/openai-image/v1/images/generations');
    assert.equal(displayProviderUrl('openai', 'https://example.test/openai-image/v1/images/generations'), 'https://example.test/openai-image');
    assert.equal(resolveProviderUrl('generic', 'https://example.test/path/'), 'https://example.test/path');
    assert.equal(resolveProviderUrl('gemini-sse', 'https://example.test/google-ai', 'gemini-image'), 'https://example.test/google-ai/v1beta/models/gemini-image:streamGenerateContent');
    assert.equal(resolveProviderUrl('gemini-sse', 'https://example.test/google-ai', 'gemini-3.1-flash-image'), 'https://example.test/google-ai/v1beta/interactions');
    assert.equal(resolveProviderUrl('gemini-sse', 'https://example.test/google-ai/v1beta/models/gemini-image:streamGenerateContent', 'gemini-image'), 'https://example.test/google-ai/v1beta/models/gemini-image:streamGenerateContent');
    assert.equal(displayProviderUrl('gemini-sse', 'https://example.test/google-ai/v1beta/models/gemini-image:streamGenerateContent'), 'https://example.test/google-ai');
    assert.equal(displayProviderUrl('gemini-sse', 'https://example.test/google-ai/v1beta/interactions'), 'https://example.test/google-ai');
    assert.throws(() => resolveProviderUrl('gemini-sse', 'https://example.test/google-ai', ''), /model is required/);
    assert.throws(() => resolveProviderUrl('openai', 'not a URL'), /valid HTTP/);
});

test('provider output redacts common secret fields recursively', () => {
    assert.deepEqual(redactSensitiveValue({ ok: true, apiKey: 'secret', nested: { token: 'secret', model: 'safe' } }), {
        ok: true,
        apiKey: '[redacted]',
        nested: { token: '[redacted]', model: 'safe' },
    });
});
