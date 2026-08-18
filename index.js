import {
    DEFAULT_SETTINGS,
    PARAM_ORDER,
    PLUGIN_SUPPORTED_PARAMS,
    buildInstruction,
    normalizeRequest,
    normalizeSettings,
    parseMessage,
    projectSchemas,
} from './parser.js';

const MODULE_NAME = 'imageSchema';
const PROMPT_KEY = 'image-schema-instruction';
const PLUGIN_BASE = '/api/plugins/image-schema';
const ROUTES = Object.freeze({
    status: `${PLUGIN_BASE}/status`,
    profiles: `${PLUGIN_BASE}/profiles`,
    test: `${PLUGIN_BASE}/test`,
    image: `${PLUGIN_BASE}/image/`,
    cacheStats: `${PLUGIN_BASE}/cache/stats`,
    cacheClear: `${PLUGIN_BASE}/cache/clear`,
});

let initialized = false;
let context;
let settings;
let observer;
let renderQueued = false;
let promptIsArmed = false;
const boundEvents = [];

function listen(event, handler) {
    if (!event) return;
    context.eventSource.on(event, handler);
    boundEvents.push([event, handler]);
}

function onChatChanged() {
    disarmPrompt();
    queueRenderAll();
}

function notify(level, message, title = 'Image Schema') {
    const toast = globalThis.toastr?.[level];
    if (typeof toast === 'function') toast(message, title);
    else console[level === 'error' ? 'error' : 'log'](`[${title}] ${message}`);
}

function requestHeaders() {
    return typeof context?.getRequestHeaders === 'function'
        ? context.getRequestHeaders()
        : { 'Content-Type': 'application/json' };
}

function saveSettings() {
    context.extensionSettings[MODULE_NAME] = settings;
    context.saveSettingsDebounced();
}

export function pluginImageUrl(request) {
    const search = new URLSearchParams();
    const pluginNames = {
        backend: 'profile',
        aspect_ratio: 'aspectRatio',
        image_size: 'imageSize',
        output_format: 'outputFormat',
        person_generation: 'personGeneration',
    };
    for (const key of PLUGIN_SUPPORTED_PARAMS) {
        if (Object.hasOwn(request.params, key)) search.set(pluginNames[key] || key, String(request.params[key]));
    }
    const query = search.toString();
    return `${ROUTES.image}${encodeURIComponent(request.text)}${query ? `?${query}` : ''}`;
}

function pluginRequestBody(request) {
    return { request };
}

function getProjectionSource(message) {
    return String(message.extra?.image_schema_original ?? message.mes ?? '');
}

function prepareMessageProjection(messageId) {
    const message = context.chat?.[Number(messageId)];
    if (!message || message.is_user || message.is_system) return [];
    message.extra ??= {};
    const ownsDisplay = message.extra.image_schema_display_text !== undefined && message.extra.display_text === message.extra.image_schema_display_text;
    if (!settings.enabled) {
        if (ownsDisplay) {
            if (message.extra.image_schema_previous_display_text === undefined) delete message.extra.display_text;
            else message.extra.display_text = message.extra.image_schema_previous_display_text;
        }
        delete message.extra.image_schema_original;
        delete message.extra.image_schema_display_text;
        delete message.extra.image_schema_previous_display_text;
        return [];
    }
    const source = getProjectionSource(message);
    const projection = projectSchemas(source, settings, { urlForRequest: pluginImageUrl });
    if (projection.occurrences.length) {
        if (message.extra.image_schema_original === undefined) {
            message.extra.image_schema_previous_display_text = message.extra.display_text;
        }
        message.extra.image_schema_original = source;
        message.extra.image_schema_display_text = projection.text;
        message.extra.display_text = projection.text;
    } else if (message.extra.image_schema_original !== undefined) {
        if (ownsDisplay) {
            if (message.extra.image_schema_previous_display_text === undefined) delete message.extra.display_text;
            else message.extra.display_text = message.extra.image_schema_previous_display_text;
        }
        delete message.extra.image_schema_original;
        delete message.extra.image_schema_display_text;
        delete message.extra.image_schema_previous_display_text;
    }
    return projection.occurrences;
}

async function pluginFetch(route, options = {}) {
    const response = await fetch(route, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...options,
        headers: {
            ...requestHeaders(),
            ...(options.headers || {}),
        },
    });
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('json') ? await response.json() : await response.text();
    if (!response.ok) {
        const detail = typeof body === 'string' ? body : body?.error || body?.message || JSON.stringify(body);
        throw new Error(`${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`);
    }
    return body;
}

function getMessageElement(messageId) {
    return document.querySelector(`#chat .mes[mesid="${CSS.escape(String(messageId))}"]`);
}

function renderError(target, error) {
    target.classList.add('image-schema-failed');
    target.removeAttribute('src');
    target.alt = `Image schema error: ${error}`;
    target.title = error;
    const wrapper = target.closest('.image-schema-frame');
    wrapper?.querySelector('.image-schema-state')?.replaceChildren(document.createTextNode(error));
}

function addImageControls(image, request, messageId, occurrence) {
    let frame = image.closest('.image-schema-frame');
    if (!frame) {
        frame = document.createElement('span');
        frame.className = 'image-schema-frame';
        image.replaceWith(frame);
        frame.append(image);
    }
    image.classList.add('image-schema-image');
    image.dataset.imageSchema = 'true';
    image.dataset.imageSchemaMessage = String(messageId);
    image.dataset.imageSchemaOccurrence = String(occurrence);
    image.dataset.imageSchemaRequest = JSON.stringify(request);

    let state = frame.querySelector('.image-schema-state');
    if (!state) {
        state = document.createElement('span');
        state.className = 'image-schema-state';
        state.textContent = 'Generating image…';
        frame.append(state);
    }
    image.addEventListener('load', () => {
        image.classList.add('image-schema-loaded');
        state.textContent = '';
    }, { once: true });
    image.addEventListener('error', () => {
        if (!image.classList.contains('image-schema-failed')) state.textContent = 'Image generation failed. Check plugin status.';
    }, { once: true });
    if (image.complete && image.naturalWidth > 0) {
        image.classList.add('image-schema-loaded');
        state.textContent = '';
    }

    if (frame.querySelector('.image-schema-actions')) return;
    const actions = document.createElement('span');
    actions.className = 'image-schema-actions';
    actions.innerHTML = `
        <button type="button" class="menu_button image-schema-copy" title="Copy image prompt"><i class="fa-solid fa-copy"></i></button>
        <button type="button" class="menu_button image-schema-inspect" title="Inspect effective request"><i class="fa-solid fa-circle-info"></i></button>
        <button type="button" class="menu_button image-schema-regenerate" title="Regenerate with a fresh seed"><i class="fa-solid fa-dice"></i></button>`;
    frame.append(actions);

    actions.querySelector('.image-schema-copy').addEventListener('click', async () => {
        await navigator.clipboard.writeText(request.text);
        notify('success', 'Image prompt copied.');
    });
    actions.querySelector('.image-schema-inspect').addEventListener('click', () => {
        window.alert(JSON.stringify(request, null, 2));
    });
    actions.querySelector('.image-schema-regenerate').addEventListener('click', () => {
        const next = structuredClone(request);
        next.params.seed = Math.floor(Math.random() * 2147483647);
        image.classList.remove('image-schema-loaded');
        state.textContent = 'Regenerating image with a fresh seed…';
        const separator = pluginImageUrl(next).includes('?') ? '&' : '?';
        image.src = `${pluginImageUrl(next)}${separator}_refresh=${Date.now()}`;
        image.dataset.imageSchemaRequest = JSON.stringify(next);
    });
}

function rewriteImages(root, occurrences, messageId) {
    const virtualPrefix = settings.virtualPath;
    const candidates = Array.from(root.querySelectorAll('img'));
    let occurrenceNumber = 0;
    for (const image of candidates) {
        const rawSource = image.getAttribute('src') || '';
        const projectedIndex = Number(image.getAttribute('data-image-schema-index'));
        const projected = Number.isInteger(projectedIndex) ? occurrences[projectedIndex] : null;
        const belongsToSchema = rawSource.startsWith(virtualPrefix) || Boolean(projected);
        if (!belongsToSchema) continue;

        let match = projected;
        if (!match) {
            const parsed = parseMessage(`<img src="${rawSource.replaceAll('"', '&quot;')}">`, { ...settings, schema: 'inline' });
            match = parsed.find(item => item.request || item.error);
        }
        if (match?.error) {
            renderError(image, match.error);
            occurrenceNumber++;
            continue;
        }
        if (!match?.request) continue;
        image.setAttribute('src', pluginImageUrl(match.request));
        addImageControls(image, match.request, messageId, occurrenceNumber);
        occurrenceNumber++;
    }
}

function renderMessage(messageId) {
    const id = Number(messageId);
    if (!Number.isInteger(id) || id < 0) return;
    const message = context.chat?.[id];
    if (!message || message.is_user || message.is_system) return;
    const messageElement = getMessageElement(id);
    const textElement = messageElement?.querySelector('.mes_text');
    if (!textElement) return;

    const occurrences = prepareMessageProjection(id);
    const displayText = message.extra?.display_text ?? message.mes ?? '';
    textElement.innerHTML = context.messageFormatting(
        displayText,
        message.name,
        Boolean(message.is_system),
        Boolean(message.is_user),
        id,
        {},
        false,
    );
    if (settings.enabled) rewriteImages(textElement, occurrences, id);
}

function renderAllMessages() {
    renderQueued = false;
    document.querySelectorAll('#chat .mes[mesid]').forEach(element => renderMessage(element.getAttribute('mesid')));
}

function queueRenderAll() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(renderAllMessages);
}

function onMutations(records) {
    if (!settings.enabled) return;
    for (const record of records) {
        const addedMessage = [...record.addedNodes].some(node =>
            node.nodeType === Node.ELEMENT_NODE &&
            (node.matches?.('.mes[mesid]') || node.querySelector?.('.mes[mesid]')),
        );
        if (!addedMessage) continue;
        queueRenderAll();
        return;
    }
}

function shouldInject(type, options, dryRun) {
    if (!settings.enabled || !settings.injectInstruction || dryRun) return false;
    const quiet = type === 'quiet' || Boolean(options?.quiet_prompt || options?.automatic_trigger);
    return !quiet || settings.injectQuiet;
}

function disarmPrompt() {
    if (!promptIsArmed) return;
    context.setExtensionPrompt(PROMPT_KEY, '', 1, 0, false, 0);
    promptIsArmed = false;
}

function onGenerationAfterCommands(type, options, dryRun) {
    disarmPrompt();
    if (!shouldInject(type, options, dryRun)) return;
    context.setExtensionPrompt(PROMPT_KEY, buildInstruction(settings), 1, 0, false, 0);
    promptIsArmed = true;
}

function bindEvents() {
    const events = context.eventTypes || context.event_types;
    if (typeof context.eventSource.makeLast === 'function') {
        context.eventSource.makeLast(events.MESSAGE_RECEIVED, prepareMessageProjection);
        boundEvents.push([events.MESSAGE_RECEIVED, prepareMessageProjection]);
    } else {
        listen(events.MESSAGE_RECEIVED, prepareMessageProjection);
    }
    listen(events.CHARACTER_MESSAGE_RENDERED, renderMessage);
    listen(events.MESSAGE_UPDATED, renderMessage);
    listen(events.MESSAGE_EDITED, renderMessage);
    listen(events.MESSAGE_SWIPED, renderMessage);
    listen(events.CHAT_CHANGED, onChatChanged);
    listen(events.CHAT_LOADED, queueRenderAll);
    listen(events.MORE_MESSAGES_LOADED, queueRenderAll);
    listen(events.GENERATION_AFTER_COMMANDS, onGenerationAfterCommands);
    listen(events.GENERATE_AFTER_DATA, disarmPrompt);
    listen(events.GENERATION_ENDED, disarmPrompt);
    listen(events.GENERATION_STOPPED, disarmPrompt);
}

function value(id) {
    const element = document.getElementById(id);
    return element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement
        ? element.value
        : '';
}

function checked(id) {
    return Boolean(document.getElementById(id)?.checked);
}

function setValue(id, input) {
    const element = document.getElementById(id);
    if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) element.value = input ?? '';
}

function setChecked(id, input) {
    const element = document.getElementById(id);
    if (element instanceof HTMLInputElement) element.checked = Boolean(input);
}

function refreshInstructionPreview() {
    const output = document.getElementById('image_schema_instruction_preview');
    if (output) output.textContent = buildInstruction(settings);
    document.querySelectorAll('[data-image-schema-panel]').forEach(panel => {
        panel.classList.toggle('displayNone', panel.getAttribute('data-image-schema-panel') !== settings.schema);
    });
}

function readSettingsForm() {
    settings.enabled = checked('image_schema_enabled');
    settings.schema = value('image_schema_mode');
    settings.virtualPath = value('image_schema_virtual_path');
    settings.jsonOpen = value('image_schema_json_open');
    settings.jsonClose = value('image_schema_json_close');
    settings.jsonTextProperty = value('image_schema_json_text');
    settings.jsonParamsProperty = value('image_schema_json_params');
    settings.delimiterOpen = value('image_schema_delimiter_open');
    settings.delimiterClose = value('image_schema_delimiter_close');
    settings.ignoreCodeBlocks = checked('image_schema_ignore_code');
    settings.unknownParameterPolicy = value('image_schema_unknown_policy');
    settings.injectInstruction = checked('image_schema_inject');
    settings.injectQuiet = checked('image_schema_inject_quiet');
    settings.useCustomInstruction = checked('image_schema_custom_enabled');
    settings.customInstruction = value('image_schema_custom_instruction');
    for (const key of PARAM_ORDER) {
        settings.defaults[key] = value(`image_schema_default_${key}`);
        settings.allowedOverrides[key] = checked(`image_schema_allow_${key}`);
    }
    settings = normalizeSettings(settings);
    saveSettings();
    refreshInstructionPreview();
    queueRenderAll();
}

function populateSettingsForm() {
    setChecked('image_schema_enabled', settings.enabled);
    setValue('image_schema_mode', settings.schema);
    setValue('image_schema_virtual_path', settings.virtualPath);
    setValue('image_schema_json_open', settings.jsonOpen);
    setValue('image_schema_json_close', settings.jsonClose);
    setValue('image_schema_json_text', settings.jsonTextProperty);
    setValue('image_schema_json_params', settings.jsonParamsProperty);
    setValue('image_schema_delimiter_open', settings.delimiterOpen);
    setValue('image_schema_delimiter_close', settings.delimiterClose);
    setChecked('image_schema_ignore_code', settings.ignoreCodeBlocks);
    setValue('image_schema_unknown_policy', settings.unknownParameterPolicy);
    setChecked('image_schema_inject', settings.injectInstruction);
    setChecked('image_schema_inject_quiet', settings.injectQuiet);
    setChecked('image_schema_custom_enabled', settings.useCustomInstruction);
    setValue('image_schema_custom_instruction', settings.customInstruction);
    for (const key of PARAM_ORDER) {
        setValue(`image_schema_default_${key}`, settings.defaults[key]);
        setChecked(`image_schema_allow_${key}`, settings.allowedOverrides[key]);
    }
    refreshInstructionPreview();
}

async function copyInstruction() {
    await navigator.clipboard.writeText(buildInstruction(settings));
    notify('success', 'Instruction copied.');
}

async function checkPluginStatus() {
    const indicator = document.getElementById('image_schema_plugin_status');
    if (indicator) {
        indicator.dataset.state = 'checking';
        indicator.textContent = 'Checking…';
    }
    try {
        const result = await pluginFetch(ROUTES.status);
        if (indicator) {
            indicator.dataset.state = 'ok';
            indicator.textContent = `Connected${result?.version ? ` · ${result.version}` : ''}`;
        }
        return result;
    } catch (error) {
        if (indicator) {
            indicator.dataset.state = 'error';
            indicator.textContent = 'Unavailable';
            indicator.title = error.message;
        }
        throw error;
    }
}

async function refreshCacheStats() {
    const output = document.getElementById('image_schema_cache_stats');
    try {
        const stats = await pluginFetch(ROUTES.cacheStats, { method: 'POST', body: '{}' });
        if (output) output.textContent = typeof stats === 'string' ? stats : JSON.stringify(stats, null, 2);
    } catch (error) {
        if (output) output.textContent = `Unavailable: ${error.message}`;
    }
}

function testParser() {
    const source = value('image_schema_test_input');
    const output = document.getElementById('image_schema_test_output');
    const result = projectSchemas(source, settings);
    if (output) output.textContent = JSON.stringify(result.occurrences.map(({ request, error }) => ({ request, error })), null, 2);
}

async function testGeneration() {
    const prompt = value('image_schema_test_prompt').trim();
    const output = document.getElementById('image_schema_generation_result');
    try {
        const request = normalizeRequest(prompt, {}, settings, { trustedParams: true });
        const result = await pluginFetch(ROUTES.test, { method: 'POST', body: JSON.stringify(pluginRequestBody(request)) });
        if (output) output.textContent = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        notify('success', 'Plugin generation test completed.');
    } catch (error) {
        if (output) output.textContent = error.message;
        notify('error', error.message);
    }
}

async function clearCache() {
    if (!window.confirm('Clear all Image Schema cache entries available to the current user?')) return;
    try {
        await pluginFetch(ROUTES.cacheClear, { method: 'POST', body: '{}' });
        notify('success', 'Image cache cleared.');
        await refreshCacheStats();
    } catch (error) { notify('error', error.message); }
}

async function addSettingsUi() {
    if (document.getElementById('image_schema_settings')) return;
    const response = await fetch(new URL('./settings.html', import.meta.url));
    if (!response.ok) throw new Error(`Could not load Image Schema settings: ${response.status}`);
    const container = document.createElement('div');
    container.innerHTML = await response.text();
    const root = container.firstElementChild;
    const target = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!root || !target) throw new Error('SillyTavern extension settings container was not found');
    target.append(root);
    populateSettingsForm();

    root.querySelectorAll('input, select, textarea').forEach(element => {
        if (element.id === 'image_schema_test_input' || element.id === 'image_schema_test_prompt') return;
        element.addEventListener(element instanceof HTMLSelectElement ? 'change' : 'input', readSettingsForm);
    });
    document.getElementById('image_schema_copy_instruction')?.addEventListener('click', copyInstruction);
    document.getElementById('image_schema_check_plugin')?.addEventListener('click', () => checkPluginStatus().catch(error => notify('error', error.message)));
    document.getElementById('image_schema_test_parser')?.addEventListener('click', testParser);
    document.getElementById('image_schema_test_generation')?.addEventListener('click', testGeneration);
    document.getElementById('image_schema_refresh_cache')?.addEventListener('click', refreshCacheStats);
    document.getElementById('image_schema_clear_cache')?.addEventListener('click', clearCache);
}

export async function init() {
    if (initialized) return;
    initialized = true;
    context = globalThis.SillyTavern?.getContext?.();
    if (!context) throw new Error('Image Schema requires SillyTavern.getContext()');
    settings = normalizeSettings(context.extensionSettings[MODULE_NAME] || DEFAULT_SETTINGS);
    context.extensionSettings[MODULE_NAME] = settings;

    await addSettingsUi();
    bindEvents();
    const chat = document.getElementById('chat');
    if (chat) {
        observer = new MutationObserver(onMutations);
        observer.observe(chat, { childList: true, subtree: true });
    }
    queueRenderAll();
    checkPluginStatus().catch(() => {});
    refreshCacheStats();
}

export async function clean() {
    disarmPrompt();
    observer?.disconnect();
    observer = undefined;
    for (const [event, handler] of boundEvents.splice(0)) {
        context?.eventSource?.removeListener?.(event, handler);
    }
    document.getElementById('image_schema_settings')?.remove();
    if (context?.chat) {
        for (const message of context.chat) {
            if (!message?.extra) continue;
            const ownsDisplay = message.extra.display_text === message.extra.image_schema_display_text;
            if (ownsDisplay) {
                if (message.extra.image_schema_previous_display_text === undefined) delete message.extra.display_text;
                else message.extra.display_text = message.extra.image_schema_previous_display_text;
            }
            delete message.extra.image_schema_original;
            delete message.extra.image_schema_display_text;
            delete message.extra.image_schema_previous_display_text;
        }
    }
    if (context?.extensionSettings) {
        delete context.extensionSettings[MODULE_NAME];
        context.saveSettingsDebounced();
    }
    initialized = false;
}

// SillyTavern 1.15 loads extension modules but does not invoke manifest lifecycle hooks.
// Initialize on module load; the guard keeps this compatible with hook-aware versions.
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => init().catch(error => console.error('[Image Schema] initialization failed', error)), { once: true });
    } else {
        init().catch(error => console.error('[Image Schema] initialization failed', error));
    }
}
