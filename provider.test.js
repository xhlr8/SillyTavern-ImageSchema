import assert from 'node:assert/strict';
import test from 'node:test';

import {
    PROVIDER_ROUTE_PATHS,
    buildProviderProfilePayload,
    inferComfyWorkflowCandidates,
    mergeComfyCandidates,
    normalizeComfyCandidates,
    normalizeProviderConfig,
    normalizeProviderProfile,
    selectInstructionProviderProfile,
    resolveProviderUrl,
    displayProviderUrl,
    parseComfyWorkflow,
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
        comfyAnalyze: '/providers/comfy/analyze',
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
                instructionPrompt: '  Prefer this profile for painterly scenes.  ',
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
        instructionPrompt: 'Prefer this profile for painterly scenes.',
        defaults: {},
        apiKeyConfigured: true,
    });
    assert.equal(Object.hasOwn(config.profiles[0], 'apiKey'), false);
});

test('generic profiles normalize method and safe defaults', () => {
    const profile = normalizeProviderProfile({ type: 'generic', method: 'post', allowedModels: 'one, two\none', defaults: { width: 512 } }, 'local');
    assert.equal(profile.name, 'local');
    assert.equal(profile.method, 'POST');
    assert.equal(profile.instructionPrompt, '');
    assert.deepEqual(profile.allowedModels, ['one', 'two']);
    assert.deepEqual(profile.defaults, { width: 512 });
});

test('instruction profile selection honors a valid global backend then falls back to provider default', () => {
    const config = {
        defaultProfile: 'default-art',
        profiles: [
            { name: 'default-art', instructionPrompt: 'default guidance' },
            { name: 'global-art', instructionPrompt: 'global guidance' },
        ],
    };
    assert.equal(selectInstructionProviderProfile(config, 'global-art').instructionPrompt, 'global guidance');
    assert.equal(selectInstructionProviderProfile(config, '').instructionPrompt, 'default guidance');
    assert.equal(selectInstructionProviderProfile(config, 'missing').instructionPrompt, 'default guidance');
});

test('ComfyUI profile config round-trips workflow and maps persisted binding contract', () => {
    const workflow = {
        6: { class_type: 'CLIPTextEncode', inputs: { text: 'hello' } },
        9: { class_type: 'SaveImage', inputs: { images: ['8', 0] } },
    };
    const profile = normalizeProviderProfile({
        name: 'local-comfy',
        type: 'comfyui',
        url: 'http://127.0.0.1:8188',
        workflow,
        bindings: { prompt: { node: 6, input: 'text' }, seed: { node: '7', input: 'seed' } },
        outputNode: 9,
        model: 'must-not-leak',
        allowedModels: ['must-not-leak'],
        apiKeyConfigured: true,
    });
    assert.deepEqual(profile.workflow, workflow);
    assert.notEqual(profile.workflow, workflow);
    assert.deepEqual(profile.bindings.positivePrompt, { node: '6', input: 'text', label: '', path: '' });
    assert.deepEqual(profile.bindings.outputNode, { node: '9', input: '', label: '', path: '' });
    assert.equal(profile.model, '');
    assert.deepEqual(profile.allowedModels, []);
    assert.equal(profile.apiKeyConfigured, false);
});

test('ComfyUI analyzer candidates normalize plugin and descriptor response shapes by confidence', () => {
    const candidates = normalizeComfyCandidates({ analysis: { ignored: true }, candidates: {
        prompt: [
            { binding: { node: '2', input: 'text' }, confidence: 0.4, reason: 'fallback', path: [{ node: '2', input: 'text' }] },
            { node: '1', input: 'text', label: 'Best prompt', confidence: 0.98, path: '/1/inputs/text', warning: 'Review' },
        ],
        outputNode: [{ node: '9', classType: 'SaveImage', confidence: 0.9 }],
    } });
    assert.equal(candidates.positivePrompt[0].node, '1');
    assert.equal(candidates.positivePrompt[0].warning, 'Review');
    assert.equal(candidates.positivePrompt[1].label, 'fallback');
    assert.match(candidates.positivePrompt[1].path, /2\.text/);
    assert.equal(candidates.outputNode[0].node, '9');
});

test('Krea2 analyzer response prioritizes upstream primitive prompt, seed, and SaveImage output', () => {
    const workflow = {
        230: { class_type: 'PrimitiveStringMultiline', inputs: { value: '' }, _meta: { title: 'Prompt' } },
        262: { class_type: 'PrimitiveInt', inputs: { value: 69 }, _meta: { title: 'seed' } },
        211: { class_type: 'SaveImage', inputs: { images: ['15', 0] } },
    };
    const candidates = mergeComfyCandidates(normalizeComfyCandidates({ candidates: {
        prompt: [{ binding: { node: '230', input: 'value' }, confidence: 0.9, reason: 'Literal string input upstream' }],
        outputNode: [{ node: '211', classType: 'SaveImage', confidence: 0.98 }],
    } }), inferComfyWorkflowCandidates(workflow));
    assert.deepEqual([candidates.positivePrompt[0].node, candidates.positivePrompt[0].input], ['230', 'value']);
    assert.deepEqual([candidates.seed[0].node, candidates.seed[0].input], ['262', 'value']);
    assert.equal(candidates.outputNode[0].node, '211');
});

test('ComfyUI save payload sends workflow and stable bindings without model fields', () => {
    const workflow = {
        6: { class_type: 'CLIPTextEncode', inputs: { text: 'hello' } },
        7: { class_type: 'KSampler', inputs: { seed: 0 } },
        8: { class_type: 'ImageNode', inputs: {} },
        9: { class_type: 'SaveImage', inputs: { images: ['8', 0] } },
    };
    const payload = buildProviderProfilePayload({
        name: 'local-comfy', type: 'comfyui', url: 'http://192.0.2.10:8188/', timeoutMs: 120000,
        instructionPrompt: '  Keep the schema concise. ', workflow, model: 'ignored', allowedModels: ['ignored'], defaults: {},
        bindings: {
            positivePrompt: { node: '6', input: 'text', label: 'Prompt', confidence: 0.99, warning: 'not persisted' },
            seed: { node: '7', input: 'seed', path: '/7/inputs/seed' },
            outputNode: { node: '9', input: '' },
        },
    });
    assert.deepEqual(payload, {
        name: 'local-comfy', type: 'comfyui', url: 'http://192.0.2.10:8188', timeoutMs: 120000,
        instructionPrompt: 'Keep the schema concise.', workflow,
        bindings: { prompt: { node: '6', input: 'text' }, seed: { node: '7', input: 'seed' } },
        outputNode: '9',
    });
    assert.equal(Object.hasOwn(payload, 'model'), false);
    assert.equal(Object.hasOwn(payload, 'allowedModels'), false);
    assert.throws(() => buildProviderProfilePayload({ name: 'bad', type: 'comfyui', url: 'http://192.0.2.10:8188', timeoutMs: 1000, workflow, bindings: {} }), /positive prompt binding/);
    assert.throws(() => buildProviderProfilePayload({
        name: 'stale', type: 'comfyui', url: 'http://192.0.2.10:8188', timeoutMs: 1000, workflow,
        bindings: { positivePrompt: { node: '404', input: 'text' } },
    }), /node 404 does not exist/);
    assert.throws(() => buildProviderProfilePayload({
        name: 'stale', type: 'comfyui', url: 'http://192.0.2.10:8188', timeoutMs: 1000, workflow,
        bindings: { positivePrompt: { node: '6', input: 'missing' } },
    }), /input missing does not exist/);
});

test('ComfyUI workflow parser accepts only non-empty JSON objects', () => {
    assert.deepEqual(parseComfyWorkflow('{"1":{"class_type":"Test","inputs":{}}}'), { 1: { class_type: 'Test', inputs: {} } });
    assert.throws(() => parseComfyWorkflow('[]'), /non-empty JSON object/);
    assert.throws(() => parseComfyWorkflow('{}'), /non-empty JSON object/);
    assert.throws(() => parseComfyWorkflow('{bad'), /valid JSON/);
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
