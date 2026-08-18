export const PARAM_ALIASES = Object.freeze({
    b: 'backend',
    backend: 'backend',
    model: 'model',
    seed: 'seed',
    ar: 'aspect_ratio',
    aspect_ratio: 'aspect_ratio',
    s: 'image_size',
    image_size: 'image_size',
    f: 'output_format',
    output_format: 'output_format',
    t: 'temperature',
    temperature: 'temperature',
    p: 'person_generation',
    person_generation: 'person_generation',
    w: 'width',
    width: 'width',
    h: 'height',
    height: 'height',
    neg: 'negative',
    negative: 'negative',
});

export const PARAM_ORDER = Object.freeze([
    'backend', 'model', 'seed', 'aspect_ratio', 'image_size', 'output_format',
    'temperature', 'person_generation', 'width', 'height', 'negative',
]);

export const PLUGIN_SUPPORTED_PARAMS = PARAM_ORDER;

export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    schema: 'inline',
    virtualPath: '/image/',
    jsonOpen: '<image>',
    jsonClose: '</image>',
    jsonTextProperty: 'text',
    jsonParamsProperty: 'params',
    delimiterOpen: '<image>',
    delimiterClose: '</image>',
    ignoreCodeBlocks: true,
    maxPromptLength: 4000,
    maxJsonLength: 16000,
    unknownParameterPolicy: 'reject',
    defaults: {
        backend: '', model: '', seed: '', aspect_ratio: '', image_size: '',
        output_format: '', temperature: '', person_generation: '', width: '',
        height: '', negative: '',
    },
    allowedOverrides: {
        backend: false, model: false, seed: true, aspect_ratio: true, image_size: true,
        output_format: true, temperature: false, person_generation: false,
        width: false, height: false, negative: true,
    },
    injectInstruction: true,
    injectQuiet: false,
    useCustomInstruction: false,
    customInstruction: '',
});

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
        (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function normalizeVirtualPath(value) {
    let path = String(value || DEFAULT_SETTINGS.virtualPath).trim();
    if (!path.startsWith('/')) path = `/${path}`;
    if (!path.endsWith('/')) path += '/';
    return path;
}

export function normalizeSettings(input = {}) {
    const result = clone(DEFAULT_SETTINGS);
    if (!isPlainObject(input)) return result;

    for (const key of Object.keys(result)) {
        if (key === 'defaults' || key === 'allowedOverrides') continue;
        if (Object.hasOwn(input, key)) result[key] = input[key];
    }
    if (isPlainObject(input.defaults)) Object.assign(result.defaults, input.defaults);
    if (isPlainObject(input.allowedOverrides)) Object.assign(result.allowedOverrides, input.allowedOverrides);

    result.enabled = Boolean(result.enabled);
    result.schema = ['inline', 'delimiter', 'json'].includes(result.schema) ? result.schema : 'inline';
    result.virtualPath = normalizeVirtualPath(result.virtualPath);
    result.maxPromptLength = Math.max(1, Number(result.maxPromptLength) || DEFAULT_SETTINGS.maxPromptLength);
    result.maxJsonLength = Math.max(2, Number(result.maxJsonLength) || DEFAULT_SETTINGS.maxJsonLength);
    result.unknownParameterPolicy = ['reject', 'ignore'].includes(result.unknownParameterPolicy) ? result.unknownParameterPolicy : 'reject';
    return result;
}

function canonicalizeValue(key, value) {
    if (value === null || value === undefined || value === '') return '';
    switch (key) {
        case 'seed':
        case 'width':
        case 'height': {
            const number = Number(value);
            if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${key} must be a non-negative integer`);
            if ((key === 'width' || key === 'height') && number === 0) throw new Error(`${key} must be greater than zero`);
            return number;
        }
        case 'temperature': {
            const number = Number(value);
            if (!Number.isFinite(number) || number < 0 || number > 2) throw new Error('temperature must be between 0 and 2');
            return number;
        }
        case 'image_size':
            return String(value).toUpperCase();
        case 'output_format': {
            const format = String(value).toLowerCase();
            return format.includes('/') ? format : `image/${format}`;
        }
        default:
            return String(value);
    }
}

export function normalizeRequest(text, suppliedParams, settingsInput, options = {}) {
    const settings = normalizeSettings(settingsInput);
    const prompt = String(text ?? '').trim();
    if (!prompt) throw new Error('image prompt must be a non-empty string');
    if (prompt.length > settings.maxPromptLength) throw new Error(`image prompt exceeds ${settings.maxPromptLength} characters`);
    if (!isPlainObject(suppliedParams)) throw new Error('params must be a plain object');

    const normalizedOverrides = {};
    const seen = new Map();
    for (const [rawKey, rawValue] of Object.entries(suppliedParams)) {
        const key = PARAM_ALIASES[rawKey];
        if (!key) {
            if (settings.unknownParameterPolicy === 'reject') throw new Error(`unknown image parameter: ${rawKey}`);
            continue;
        }
        if (!options.trustedParams && !settings.allowedOverrides[key]) {
            throw new Error(`image parameter is not allowed as a model override: ${rawKey}`);
        }
        const value = canonicalizeValue(key, rawValue);
        if (seen.has(key) && seen.get(key) !== value) throw new Error(`conflicting aliases for image parameter: ${key}`);
        seen.set(key, value);
        if (value !== '') normalizedOverrides[key] = value;
    }

    const params = {};
    for (const key of PARAM_ORDER) {
        const fallback = canonicalizeValue(key, settings.defaults[key]);
        if (fallback !== '') params[key] = fallback;
    }
    Object.assign(params, normalizedOverrides);
    return { text: prompt, params };
}

function codeRanges(text) {
    const ranges = [];
    const regex = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*(?:`|$)/g;
    let match;
    while ((match = regex.exec(text))) ranges.push([match.index, match.index + match[0].length]);
    return ranges;
}

function overlaps(ranges, start, end) {
    return ranges.some(([from, to]) => start < to && end > from);
}

function parsePairs(source, open, close, settings, parseBody) {
    if (!open || !close) return [];
    const ignored = settings.ignoreCodeBlocks ? codeRanges(source) : [];
    const output = [];
    let cursor = 0;
    while (cursor < source.length) {
        const start = source.indexOf(open, cursor);
        if (start < 0) break;
        const bodyStart = start + open.length;
        const closeAt = source.indexOf(close, bodyStart);
        if (closeAt < 0) break; // incomplete streamed schema: do not submit
        const end = closeAt + close.length;
        cursor = end;
        if (overlaps(ignored, start, end)) continue;
        try {
            const request = parseBody(source.slice(bodyStart, closeAt));
            output.push({ start, end, raw: source.slice(start, end), request });
        } catch (error) {
            output.push({ start, end, raw: source.slice(start, end), error: error instanceof Error ? error.message : String(error) });
        }
    }
    return output;
}

function parseQuery(query) {
    const params = {};
    const decodedQuery = String(query || '').replaceAll('&amp;', '&');
    const search = new URLSearchParams(decodedQuery);
    for (const [key, value] of search) {
        if (Object.hasOwn(params, key) && params[key] !== value) {
            throw new Error(`conflicting duplicate image parameter: ${key}`);
        }
        params[key] = value;
    }
    return params;
}

function decodePrompt(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        throw new Error('image prompt contains malformed URL encoding');
    }
}

export function parseVirtualSource(src, settingsInput) {
    const settings = normalizeSettings(settingsInput);
    let value = String(src || '').replaceAll('&amp;', '&');
    try {
        const url = new URL(value, 'https://sillytavern.invalid');
        if (url.origin !== 'https://sillytavern.invalid' || !url.pathname.startsWith(settings.virtualPath)) return null;
        value = `${url.pathname}${url.search}`;
    } catch {
        return null;
    }
    if (!value.startsWith(settings.virtualPath)) return null;
    const rest = value.slice(settings.virtualPath.length);
    const queryAt = rest.indexOf('?');
    const encodedPrompt = queryAt < 0 ? rest : rest.slice(0, queryAt);
    const query = queryAt < 0 ? '' : rest.slice(queryAt + 1);
    if (!encodedPrompt) throw new Error('virtual image URL has no prompt');
    return normalizeRequest(decodePrompt(encodedPrompt), parseQuery(query), settings);
}

export function parseMessage(sourceInput, settingsInput) {
    const source = String(sourceInput ?? '');
    const settings = normalizeSettings(settingsInput);
    if (settings.schema === 'json') {
        return parsePairs(source, settings.jsonOpen, settings.jsonClose, settings, body => {
            if (body.length > settings.maxJsonLength) throw new Error(`image JSON exceeds ${settings.maxJsonLength} characters`);
            let value;
            try { value = JSON.parse(body); } catch (error) { throw new Error(`invalid image JSON: ${error.message}`); }
            if (!isPlainObject(value)) throw new Error('image JSON must be an object');
            if (!Object.hasOwn(value, settings.jsonTextProperty) || !Object.hasOwn(value, settings.jsonParamsProperty)) {
                throw new Error(`image JSON requires ${settings.jsonTextProperty} and ${settings.jsonParamsProperty}`);
            }
            return normalizeRequest(value[settings.jsonTextProperty], value[settings.jsonParamsProperty], settings);
        });
    }
    if (settings.schema === 'delimiter') {
        return parsePairs(source, settings.delimiterOpen, settings.delimiterClose, settings,
            body => normalizeRequest(body, {}, settings));
    }

    const results = [];
    const ignored = settings.ignoreCodeBlocks ? codeRanges(source) : [];
    const tagRegex = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
    let match;
    while ((match = tagRegex.exec(source))) {
        if (overlaps(ignored, match.index, match.index + match[0].length)) continue;
        const src = match[1] ?? match[2] ?? match[3] ?? '';
        try {
            const request = parseVirtualSource(src, settings);
            if (request) results.push({ start: match.index, end: match.index + match[0].length, raw: match[0], src, request });
        } catch (error) {
            results.push({ start: match.index, end: match.index + match[0].length, raw: match[0], src, error: error instanceof Error ? error.message : String(error) });
        }
    }
    return results;
}

export function requestToVirtualUrl(request, settingsInput) {
    const settings = normalizeSettings(settingsInput);
    const search = new URLSearchParams();
    for (const key of PARAM_ORDER) {
        if (Object.hasOwn(request.params, key)) search.set(key, String(request.params[key]));
    }
    const query = search.toString();
    return `${settings.virtualPath}${encodeURIComponent(request.text)}${query ? `?${query}` : ''}`;
}

function replaceImageSource(tag, source) {
    return tag.replace(/(\bsrc\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s>]+)/i, `$1"${escapeAttribute(source)}"`);
}

function occurrenceKey(occurrence, duplicateIndex) {
    const value = `${occurrence.request.text}\n${JSON.stringify(occurrence.request.params)}\n${duplicateIndex}`;
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

export function projectSchemas(sourceInput, settingsInput, options = {}) {
    const source = String(sourceInput ?? '');
    const settings = normalizeSettings(settingsInput);
    const occurrences = parseMessage(source, settings);
    if (occurrences.length === 0) return { text: source, occurrences };
    const urlForRequest = typeof options.urlForRequest === 'function'
        ? options.urlForRequest
        : request => requestToVirtualUrl(request, settings);
    const duplicateCounts = new Map();
    let cursor = 0;
    let text = '';
    for (const occurrence of occurrences) {
        text += source.slice(cursor, occurrence.start);
        if (occurrence.error) {
            text += `<span class="image-schema-error" title="${escapeAttribute(occurrence.error)}">[Image schema error: ${escapeText(occurrence.error)}]</span>`;
        } else {
            const signature = `${occurrence.request.text}\n${JSON.stringify(occurrence.request.params)}`;
            const duplicateIndex = duplicateCounts.get(signature) || 0;
            duplicateCounts.set(signature, duplicateIndex + 1);
            const key = occurrenceKey(occurrence, duplicateIndex);
            const url = urlForRequest(occurrence.request);
            occurrence.key = key;
            if (settings.schema === 'inline') {
                const rewritten = replaceImageSource(occurrence.raw, url);
                text += rewritten.replace(/>$/, ` data-image-schema-key="${key}">`);
            } else {
                text += `<img src="${escapeAttribute(url)}" alt="Generated image: ${escapeAttribute(occurrence.request.text)}" data-image-schema-key="${key}">`;
            }
        }
        cursor = occurrence.end;
    }
    text += source.slice(cursor);
    return { text, occurrences };
}

function escapeText(value) {
    return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeAttribute(value) {
    return escapeText(value).replaceAll('"', '&quot;');
}

export function buildInstruction(settingsInput) {
    const settings = normalizeSettings(settingsInput);
    if (settings.useCustomInstruction && String(settings.customInstruction).trim()) return String(settings.customInstruction).trim();
    const allowed = PARAM_ORDER.filter(key => settings.allowedOverrides[key]);
    const aliases = { backend: 'b', aspect_ratio: 'ar', image_size: 's', output_format: 'f', temperature: 't', person_generation: 'p', width: 'w', height: 'h', negative: 'neg', model: 'model', seed: 'seed' };
    const allowedText = allowed.length ? ` Allowed optional parameters: ${allowed.map(key => `${aliases[key]} (${key})`).join(', ')}.` : '';
    const common = 'When an image would improve the response, include the image schema directly in the response. You may include multiple complete image schemas. Do not put image schemas inside code fences.';

    if (settings.schema === 'json') {
        return `${common} Use strict JSON exactly between ${settings.jsonOpen} and ${settings.jsonClose}. The JSON object must contain both "${settings.jsonTextProperty}" (a non-empty image prompt string) and "${settings.jsonParamsProperty}" (an object, which may be empty). Example: ${settings.jsonOpen}{"${settings.jsonTextProperty}":"a silver-haired traveler","${settings.jsonParamsProperty}":{"seed":42}}${settings.jsonClose}.${allowedText}`;
    }
    if (settings.schema === 'delimiter') {
        return `${common} Put only the image prompt between ${settings.delimiterOpen} and ${settings.delimiterClose}; parameters are configured by the user. Example: ${settings.delimiterOpen}a silver-haired traveler at sunset${settings.delimiterClose}.`;
    }
    return `${common} Use an HTML image tag whose src starts with the virtual path ${settings.virtualPath} followed by encodeURIComponent(prompt). Use standard query syntax with literal & separators. Example: <img src="${settings.virtualPath}a%20silver-haired%20traveler?ar=3%3A4&seed=42">.${allowedText}`;
}
