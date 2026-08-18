export const PROVIDER_TYPES = Object.freeze(['openai', 'gemini-sse', 'generic']);
export const GENERIC_METHODS = Object.freeze(['GET', 'POST']);

export const PROVIDER_ROUTE_PATHS = Object.freeze({
    config: '/providers/config',
    profileSave: '/providers/profile/save',
    profileDelete: '/providers/profile/delete',
    defaultProfile: '/providers/default',
    secret: '/providers/secret',
    profileTest: '/providers/profile/test',
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
        if (/:streamGenerateContent$/i.test(pathname)) return url.toString();
        const selectedModel = firstString(model);
        if (!selectedModel) throw new Error('Gemini model is required when using a base URL');
        if (/\/v1beta$/i.test(pathname)) pathname += `/models/${encodeURIComponent(selectedModel)}:streamGenerateContent`;
        else pathname += `/v1beta/models/${encodeURIComponent(selectedModel)}:streamGenerateContent`;
        url.pathname = pathname.replace(/\/{2,}/g, '/');
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
        else url.pathname = url.pathname.replace(/\/v1beta\/models\/[^/]+:streamGenerateContent\/?$/i, '') || '/';
        return url.toString().replace(/\/$/, '');
    } catch {
        return raw;
    }
}

export function normalizeProviderProfile(input = {}, fallbackName = '') {
    const source = isPlainObject(input) ? input : {};
    const type = PROVIDER_TYPES.includes(source.type) ? source.type : 'openai';
    const timeoutValue = Number(source.timeoutMs ?? source.timeout);
    return {
        name: firstString(source.name, source.id, fallbackName),
        type,
        url: firstString(source.url, source.baseUrl, source.endpoint),
        method: type === 'generic' ? normalizeGenericMethod(source.method) : '',
        model: firstString(source.model),
        allowedModels: normalizeAllowedModels(source.allowedModels),
        timeoutMs: Number.isSafeInteger(timeoutValue) && timeoutValue > 0 ? timeoutValue : DEFAULT_TIMEOUT_MS,
        defaults: isPlainObject(source.defaults) ? structuredClone(source.defaults) : {},
        apiKeyConfigured: Boolean(source.apiKeyConfigured ?? source.hasApiKey ?? source.hasSecret ?? source.secretConfigured),
    };
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
    return { profiles: namedProfiles, defaultProfile };
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
