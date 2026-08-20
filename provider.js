export const PROVIDER_TYPES = Object.freeze(['openai', 'gemini-sse', 'generic', 'comfyui']);
export const GENERIC_METHODS = Object.freeze(['GET', 'POST']);
export const COMFY_BINDING_KEYS = Object.freeze(['positivePrompt', 'negativePrompt', 'seed', 'width', 'height', 'outputNode']);

export const PROVIDER_ROUTE_PATHS = Object.freeze({
    config: '/providers/config',
    profileSave: '/providers/profile/save',
    profileDelete: '/providers/profile/delete',
    defaultProfile: '/providers/default',
    secret: '/providers/secret',
    profileTest: '/providers/profile/test',
    comfyAnalyze: '/providers/comfy/analyze',
});

const DEFAULT_TIMEOUT_MS = 120000;

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstString(...values) {
    const value = values.find(item => typeof item === 'string');
    return value === undefined ? '' : value.trim();
}

function normalizeAllowedModels(value) {
    const models = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\n,]/) : [];
    return [...new Set(models.map(model => String(model).trim()).filter(Boolean))];
}

function clonePlainObject(value) {
    return isPlainObject(value) ? structuredClone(value) : null;
}

export function normalizeComfyBinding(value) {
    if (!isPlainObject(value)) return null;
    const coordinate = isPlainObject(value.binding) ? value.binding : value;
    if (coordinate.node === undefined || coordinate.node === null || String(coordinate.node).trim() === '') return null;
    const confidence = Number(value.confidence ?? coordinate.confidence);
    const rawPath = value.path ?? coordinate.path;
    const path = Array.isArray(rawPath)
        ? rawPath.map(step => isPlainObject(step) ? [step.node, step.input].filter(Boolean).join('.') : String(step)).join(' → ')
        : firstString(rawPath);
    const binding = {
        node: String(coordinate.node).trim(),
        input: firstString(coordinate.input),
        label: firstString(value.label, coordinate.label),
        path,
    };
    if (Number.isFinite(confidence)) binding.confidence = confidence;
    for (const [key, item] of [
        ['reason', firstString(value.reason, coordinate.reason)],
        ['warning', firstString(value.warning, coordinate.warning)],
        ['classType', firstString(value.classType, value.class_type, coordinate.classType, coordinate.class_type)],
        ['title', firstString(value.title, coordinate.title)],
        ['scalar', firstString(value.scalar, coordinate.scalar)],
    ]) {
        if (item) binding[key] = item;
    }
    return binding;
}

export function normalizeComfyBindings(value, outputNode = undefined) {
    const source = isPlainObject(value) ? value : {};
    const aliases = {
        positivePrompt: ['positivePrompt', 'prompt', 'positive'],
        negativePrompt: ['negativePrompt', 'negative'],
        seed: ['seed'],
        width: ['width'],
        height: ['height'],
        outputNode: ['outputNode', 'output'],
    };
    const output = {};
    for (const key of COMFY_BINDING_KEYS) {
        const raw = aliases[key].map(alias => source[alias]).find(item => item !== undefined);
        output[key] = normalizeComfyBinding(raw);
    }
    const standaloneOutput = outputNode ?? source.outputNode;
    if (!output.outputNode && standaloneOutput !== undefined && standaloneOutput !== null && String(standaloneOutput).trim()) {
        output.outputNode = normalizeComfyBinding({ node: standaloneOutput, input: '' });
    }
    return output;
}

export function normalizeComfyCandidates(input = {}) {
    const source = isPlainObject(input?.candidates) ? input.candidates : isPlainObject(input) ? input : {};
    const aliases = {
        positivePrompt: ['positivePrompt', 'positive_prompt', 'positive', 'prompt'],
        negativePrompt: ['negativePrompt', 'negative_prompt', 'negative'],
        seed: ['seed'],
        width: ['width'],
        height: ['height'],
        outputNode: ['outputNode', 'output_node', 'output'],
    };
    const output = {};
    for (const key of COMFY_BINDING_KEYS) {
        const raw = aliases[key].map(alias => source[alias]).find(Array.isArray) || [];
        output[key] = raw.map(normalizeComfyBinding).filter(Boolean).sort((left, right) => (right.confidence ?? -1) - (left.confidence ?? -1));
    }
    return output;
}

function isComfyLink(value) {
    return Array.isArray(value) && value.length >= 2 && ['string', 'number'].includes(typeof value[0]);
}

function comfyScalarText(value) {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (isComfyLink(value)) return `linked from ${value[0]}.${value[1]}`;
    try { return JSON.stringify(value); } catch { return String(value); }
}

function bindingDescriptor(workflow, node) {
    const descriptor = isPlainObject(workflow?.[node]) ? workflow[node] : {};
    return {
        descriptor,
        classType: firstString(descriptor.class_type) || 'Unknown',
        title: firstString(descriptor._meta?.title),
    };
}

export function formatComfyBindingLabel(binding, workflow = {}) {
    const normalized = normalizeComfyBinding(binding);
    if (!normalized) return '';
    const descriptor = bindingDescriptor(workflow, normalized.node);
    const classType = firstString(normalized.classType, descriptor.classType) || 'Unknown';
    const title = firstString(normalized.title, descriptor.title);
    const coordinate = `${normalized.node}${normalized.input ? `.${normalized.input}` : ''}`;
    return `${coordinate} — ${classType}${title ? ` “${title}”` : ''}${normalized.warning ? ' ⚠' : ''}`;
}

export function formatComfyBindingHelp(binding) {
    const normalized = normalizeComfyBinding(binding);
    if (!normalized) return '';
    const details = [];
    if (normalized.reason) details.push(normalized.reason);
    if (normalized.path) details.push(`Path: ${normalized.path}`);
    if (Number.isFinite(normalized.confidence)) details.push(`Confidence: ${Math.round(normalized.confidence * 100)}%`);
    if (normalized.warning) details.push(`Warning: ${normalized.warning}`);
    return details.join(' · ');
}

function localCandidate(workflow, node, input, role, value, overrides = {}) {
    const { classType, title } = bindingDescriptor(workflow, node);
    const linked = isComfyLink(value);
    const path = `/${node}/inputs/${input}`;
    return normalizeComfyBinding({
        node,
        input,
        classType,
        title,
        scalar: comfyScalarText(value),
        path,
        reason: linked ? `Linked ${role} input` : `Direct ${role} scalar input`,
        warning: linked ? 'Selecting this input replaces its workflow link' : '',
        confidence: linked ? 0.35 : 0.5,
        ...overrides,
    });
}

function roleScore(role, semantic, linked) {
    const patterns = {
        positivePrompt: /positive|(^|\W)prompt|text|string/i,
        negativePrompt: /negative|neg[_ -]?prompt/i,
        seed: /seed|noise/i,
        width: /width|resolution[_ -]?x|size[_ -]?x/i,
        height: /height|resolution[_ -]?y|size[_ -]?y/i,
    };
    if (role === 'positivePrompt' && /negative|neg[_ -]?prompt/i.test(semantic)) return linked ? 0.3 : 0.42;
    const exact = patterns[role]?.test(semantic);
    return exact ? (linked ? 0.78 : 0.94) : (linked ? 0.35 : 0.5);
}

export function enumerateComfyWorkflowCandidates(workflow, key) {
    if (!COMFY_BINDING_KEYS.includes(key) || !isPlainObject(workflow)) return [];
    const candidates = [];
    for (const [node, descriptor] of Object.entries(workflow)) {
        if (!isPlainObject(descriptor)) continue;
        const { classType, title } = bindingDescriptor(workflow, node);
        if (key === 'outputNode') {
            if (/(save|preview).*image|image.*(save|preview)/i.test(`${classType} ${title}`)) {
                candidates.push(normalizeComfyBinding({
                    node,
                    input: '',
                    classType,
                    title,
                    path: `/${node}`,
                    reason: `${classType} is a workflow image output node`,
                    confidence: /save/i.test(classType) ? 0.98 : 0.88,
                }));
            }
            continue;
        }
        if (!isPlainObject(descriptor.inputs)) continue;
        for (const [input, scalar] of Object.entries(descriptor.inputs)) {
            const linked = isComfyLink(scalar);
            const semantic = `${node} ${classType} ${title} ${input}`;
            const stringRole = key === 'positivePrompt' || key === 'negativePrompt';
            const integerRole = key === 'seed' || key === 'width' || key === 'height';
            const compatible = stringRole
                ? typeof scalar === 'string' || (linked && /prompt|text|string|positive|negative/i.test(semantic))
                : integerRole && ((Number.isSafeInteger(scalar) && scalar >= 0) || (linked && ({
                    seed: /seed|noise/i,
                    width: /width|resolution|size|dimension/i,
                    height: /height|resolution|size|dimension/i,
                })[key].test(semantic)));
            if (!compatible) continue;
            candidates.push(localCandidate(workflow, node, input, key, scalar, {
                confidence: roleScore(key, semantic, linked),
                reason: linked ? `Linked input compatible with ${key}` : `Direct scalar compatible with ${key}`,
            }));
        }
    }
    return mergeComfyCandidates({ [key]: candidates })[key];
}

function upstreamScalarCandidates(workflow, key, sinks) {
    const output = [];
    const wantedType = key === 'positivePrompt' || key === 'negativePrompt' ? 'string' : 'integer';
    for (const sink of sinks) {
        const sinkValue = workflow?.[sink.node]?.inputs?.[sink.input];
        if (!isComfyLink(sinkValue)) continue;
        const queue = [{ node: String(sinkValue[0]), path: `${sink.node}.${sink.input} → ${sinkValue[0]}.${sinkValue[1]}`, depth: 0 }];
        const visited = new Set();
        while (queue.length) {
            const current = queue.shift();
            if (current.depth > 6 || visited.has(current.node)) continue;
            visited.add(current.node);
            const descriptor = workflow?.[current.node];
            if (!isPlainObject(descriptor?.inputs)) continue;
            const { classType, title } = bindingDescriptor(workflow, current.node);
            for (const [input, scalar] of Object.entries(descriptor.inputs)) {
                const semantic = `${classType} ${title} ${input}`;
                const directCompatible = wantedType === 'string' ? typeof scalar === 'string' : Number.isSafeInteger(scalar) && scalar >= 0;
                if (directCompatible) {
                    const semanticMatch = roleScore(key, semantic, false) > 0.5 || /primitive|resolution|dimension|size/i.test(`${classType} ${title}`);
                    output.push(localCandidate(workflow, current.node, input, key, scalar, {
                        confidence: semanticMatch ? Math.max(0.86, (sink.confidence ?? 0.5) - current.depth * 0.04) : 0.62,
                        reason: `Upstream ${wantedType} scalar for ${sink.node}.${sink.input}`,
                        path: `${current.path} → ${current.node}.${input}`,
                    }));
                } else if (isComfyLink(scalar)) {
                    queue.push({ node: String(scalar[0]), path: `${current.path} → ${current.node}.${input} → ${scalar[0]}.${scalar[1]}`, depth: current.depth + 1 });
                }
            }
        }
    }
    return output;
}

export function inferComfyWorkflowCandidates(workflow) {
    const output = Object.fromEntries(COMFY_BINDING_KEYS.map(key => [key, enumerateComfyWorkflowCandidates(workflow, key)]));
    if (!isPlainObject(workflow)) return output;
    for (const key of ['positivePrompt', 'negativePrompt', 'width', 'height']) {
        output[key] = mergeComfyCandidates({ [key]: [...upstreamScalarCandidates(workflow, key, output[key]), ...output[key]] })[key];
    }
    return output;
}

export function mergeComfyCandidates(...candidateSets) {
    const output = Object.fromEntries(COMFY_BINDING_KEYS.map(key => [key, []]));
    for (const key of COMFY_BINDING_KEYS) {
        const seen = new Set();
        output[key] = candidateSets.flatMap(set => set?.[key] || []).map(normalizeComfyBinding).filter(binding => {
            if (!binding) return false;
            const token = `${binding.node}\u0000${binding.input}`;
            if (seen.has(token)) return false;
            seen.add(token);
            return true;
        }).sort((left, right) => (right.confidence ?? -1) - (left.confidence ?? -1));
    }
    return output;
}

export function chooseComfyBinding(workflow, key, current, candidates = []) {
    const selected = normalizeComfyBinding(current);
    const descriptor = selected && isPlainObject(workflow?.[selected.node]) ? workflow[selected.node] : null;
    const valid = Boolean(descriptor && (key === 'outputNode' || (selected.input && isPlainObject(descriptor.inputs) && Object.hasOwn(descriptor.inputs, selected.input))));
    if (valid) return selected;
    return normalizeComfyBinding(candidates[0]);
}

export function countComfyWorkflowNodes(workflow) {
    return isPlainObject(workflow) ? Object.keys(workflow).length : 0;
}

export function parseComfyWorkflow(value) {
    let workflow = value;
    if (typeof value === 'string') {
        try { workflow = JSON.parse(value); }
        catch (error) { throw new Error(`ComfyUI workflow must be valid JSON: ${error.message}`); }
    }
    if (!isPlainObject(workflow) || !countComfyWorkflowNodes(workflow)) throw new Error('ComfyUI workflow must be a non-empty JSON object exported in API format');
    return structuredClone(workflow);
}

function assertComfyBindingTarget(workflow, binding, label, { inputRequired = true } = {}) {
    if (!binding) return;
    const node = workflow[binding.node];
    if (!isPlainObject(node)) throw new Error(`ComfyUI ${label} binding node ${binding.node} does not exist in the workflow`);
    if (inputRequired && (!binding.input || !isPlainObject(node.inputs) || !Object.hasOwn(node.inputs, binding.input))) {
        throw new Error(`ComfyUI ${label} binding input ${binding.input || '(empty)'} does not exist on node ${binding.node}`);
    }
}

export function buildProviderProfilePayload(input = {}) {
    const type = PROVIDER_TYPES.includes(input.type) ? input.type : 'openai';
    const name = firstString(input.name);
    if (!name) throw new Error('Provider profile name is required');
    const timeoutMs = Number(input.timeoutMs);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Provider timeout must be a positive integer');
    const profile = {
        name,
        type,
        url: resolveProviderUrl(type, input.url, input.model),
        timeoutMs,
        instructionPrompt: firstString(input.instructionPrompt),
    };
    if (type === 'comfyui') {
        profile.workflow = parseComfyWorkflow(input.workflow);
        const selected = normalizeComfyBindings(input.bindings);
        if (!selected.positivePrompt?.input) throw new Error('ComfyUI positive prompt binding is required');
        assertComfyBindingTarget(profile.workflow, selected.positivePrompt, 'positive prompt');
        assertComfyBindingTarget(profile.workflow, selected.negativePrompt, 'negative prompt');
        assertComfyBindingTarget(profile.workflow, selected.seed, 'seed');
        assertComfyBindingTarget(profile.workflow, selected.width, 'width');
        assertComfyBindingTarget(profile.workflow, selected.height, 'height');
        assertComfyBindingTarget(profile.workflow, selected.outputNode, 'output node', { inputRequired: false });
        profile.bindings = {
            prompt: { node: selected.positivePrompt.node, input: selected.positivePrompt.input },
            ...(selected.negativePrompt?.input ? { negative: { node: selected.negativePrompt.node, input: selected.negativePrompt.input } } : {}),
            ...(selected.seed?.input ? { seed: { node: selected.seed.node, input: selected.seed.input } } : {}),
            ...(selected.width?.input ? { width: { node: selected.width.node, input: selected.width.input } } : {}),
            ...(selected.height?.input ? { height: { node: selected.height.node, input: selected.height.input } } : {}),
        };
        if (selected.outputNode) profile.outputNode = selected.outputNode.node;
        return profile;
    }
    profile.defaults = isPlainObject(input.defaults) ? structuredClone(input.defaults) : {};
    profile.model = firstString(input.model);
    profile.allowedModels = normalizeAllowedModels(input.allowedModels);
    if (type === 'generic') profile.method = normalizeGenericMethod(input.method);
    return profile;
}

export function normalizeGenericMethod(value) {
    const method = firstString(value).toUpperCase();
    return GENERIC_METHODS.includes(method) ? method : 'POST';
}

export function resolveProviderUrl(type, input, model = '') {
    const raw = firstString(input);
    if (!raw) return '';
    let url;
    try { url = new URL(raw); } catch { throw new Error('Provider URL must be a valid HTTP(S) URL'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Provider URL must use HTTP or HTTPS');
    if (type === 'comfyui' && ['0.0.0.0', '127.0.0.1', 'localhost'].includes(url.hostname)) {
        throw new Error('ComfyUI URL must be reachable from the SillyTavern server; use this PC’s LAN or Tailscale address, not a local/bind address');
    }
    let pathname = url.pathname.replace(/\/+$/, '');
    if (type === 'openai') {
        if (/\/v1\/images\/generations$/i.test(pathname)) {
            url.pathname = pathname;
            return url.toString();
        }
        if (/\/v1$/i.test(pathname)) pathname += '/images/generations';
        else pathname += '/v1/images/generations';
        url.pathname = pathname.replace(/\/{2,}/g, '/');
        return url.toString();
    }
    if (type === 'gemini-sse') {
        if (/\/v1beta\/interactions$/i.test(pathname) || /:streamGenerateContent$/i.test(pathname)) return url.toString();
        const selectedModel = firstString(model);
        if (!selectedModel) throw new Error('Gemini model is required when using a base URL');
        if (/^gemini-3(?:\.|-|$)/i.test(selectedModel)) {
            url.pathname = `${pathname}/v1beta/interactions`.replace(/\/{2,}/g, '/');
        } else if (/\/v1beta$/i.test(pathname)) {
            url.pathname = `${pathname}/models/${encodeURIComponent(selectedModel)}:streamGenerateContent`;
        } else {
            url.pathname = `${pathname}/v1beta/models/${encodeURIComponent(selectedModel)}:streamGenerateContent`.replace(/\/{2,}/g, '/');
        }
        return url.toString();
    }
    return url.toString().replace(/\/$/, '');
}

export function displayProviderUrl(type, input) {
    const raw = firstString(input);
    if (!raw || !['openai', 'gemini-sse'].includes(type)) return raw;
    try {
        const url = new URL(raw);
        if (type === 'openai') url.pathname = url.pathname.replace(/\/v1\/images\/generations\/?$/i, '') || '/';
        else url.pathname = url.pathname.replace(/\/v1beta\/(?:models\/[^/]+:streamGenerateContent|interactions)\/?$/i, '') || '/';
        return url.toString().replace(/\/$/, '');
    } catch {
        return raw;
    }
}

export function normalizeProviderProfile(input = {}, fallbackName = '') {
    const source = isPlainObject(input) ? input : {};
    const type = PROVIDER_TYPES.includes(source.type) ? source.type : 'openai';
    const timeoutValue = Number(source.timeoutMs ?? source.timeout);
    const profile = {
        name: firstString(source.name, source.id, fallbackName),
        type,
        url: firstString(source.url, source.baseUrl, source.endpoint),
        method: type === 'generic' ? normalizeGenericMethod(source.method) : '',
        model: type === 'comfyui' ? '' : firstString(source.model),
        allowedModels: type === 'comfyui' ? [] : normalizeAllowedModels(source.allowedModels),
        timeoutMs: Number.isSafeInteger(timeoutValue) && timeoutValue > 0 ? timeoutValue : DEFAULT_TIMEOUT_MS,
        instructionPrompt: firstString(source.instructionPrompt),
        defaults: isPlainObject(source.defaults) ? structuredClone(source.defaults) : {},
        apiKeyConfigured: type === 'comfyui' ? false : Boolean(source.apiKeyConfigured ?? source.hasApiKey ?? source.hasSecret ?? source.secretConfigured),
    };
    if (type === 'comfyui') {
        profile.workflow = clonePlainObject(source.workflow);
        profile.workflowName = firstString(source.workflowName, source.workflow?.name);
        profile.bindings = normalizeComfyBindings(source.bindings, source.outputNode);
    }
    return profile;
}

export function normalizeProviderConfig(input = {}) {
    const source = isPlainObject(input?.config) ? input.config : isPlainObject(input) ? input : {};
    const rawProfiles = source.profiles;
    const profiles = Array.isArray(rawProfiles)
        ? rawProfiles.map(profile => normalizeProviderProfile(profile))
        : isPlainObject(rawProfiles)
            ? Object.entries(rawProfiles).map(([name, profile]) => normalizeProviderProfile(profile, name))
            : [];
    const namedProfiles = profiles.filter(profile => profile.name);
    const defaultProfile = firstString(source.defaultProfile, source.default, source.defaultProvider);
    const routingSource = isPlainObject(source.routing) ? source.routing : {};
    const routing = {
        enabled: routingSource.enabled === true,
        fallbackProfile: firstString(routingSource.fallbackProfile),
        fallbackOn: Array.isArray(routingSource.fallbackOn) ? routingSource.fallbackOn.map(String) : [],
    };
    return { profiles: namedProfiles, defaultProfile, routing };
}

export function selectInstructionProviderProfile(configInput = {}, backendDefault = '') {
    const config = normalizeProviderConfig(configInput);
    const backendProfile = config.profiles.find(profile => profile.name === firstString(backendDefault));
    return backendProfile || config.profiles.find(profile => profile.name === config.defaultProfile) || null;
}

export function parseAllowedModels(value) {
    return normalizeAllowedModels(value);
}

export function parseProviderDefaults(value) {
    const source = String(value ?? '').trim();
    if (!source) return {};
    let parsed;
    try {
        parsed = JSON.parse(source);
    } catch (error) {
        throw new Error(`Provider defaults must be valid JSON: ${error.message}`);
    }
    if (!isPlainObject(parsed)) throw new Error('Provider defaults must be a JSON object');
    return parsed;
}

export function serializeProviderDefaults(value) {
    return JSON.stringify(isPlainObject(value) ? value : {}, null, 2);
}

export function redactSensitiveValue(value) {
    if (Array.isArray(value)) return value.map(redactSensitiveValue);
    if (!isPlainObject(value)) return value;
    const output = {};
    for (const [key, item] of Object.entries(value)) {
        if (/^(api[-_]?key|authorization|secret|token)$/i.test(key)) output[key] = '[redacted]';
        else output[key] = redactSensitiveValue(item);
    }
    return output;
}
