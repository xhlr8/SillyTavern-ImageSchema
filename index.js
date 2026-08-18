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
import {
    COMFY_BINDING_KEYS,
    PROVIDER_ROUTE_PATHS,
    buildProviderProfilePayload,
    countComfyWorkflowNodes,
    inferComfyWorkflowCandidates,
    mergeComfyCandidates,
    normalizeComfyBinding,
    normalizeComfyCandidates,
    normalizeGenericMethod,
    normalizeProviderConfig,
    normalizeProviderProfile,
    displayProviderUrl,
    resolveProviderUrl,
    parseAllowedModels,
    parseProviderDefaults,
    parseComfyWorkflow,
    redactSensitiveValue,
    serializeProviderDefaults,
} from './provider.js';

const MODULE_NAME = 'imageSchema';
const PROMPT_KEY = 'image-schema-instruction';
const PLUGIN_BASE = '/api/plugins/image-schema';
export const ROUTES = Object.freeze({
    status: `${PLUGIN_BASE}/status`,
    test: `${PLUGIN_BASE}/test`,
    image: `${PLUGIN_BASE}/image/`,
    cacheStats: `${PLUGIN_BASE}/cache/stats`,
    cacheClear: `${PLUGIN_BASE}/cache/clear`,
    providerConfig: `${PLUGIN_BASE}${PROVIDER_ROUTE_PATHS.config}`,
    providerProfileSave: `${PLUGIN_BASE}${PROVIDER_ROUTE_PATHS.profileSave}`,
    providerProfileDelete: `${PLUGIN_BASE}${PROVIDER_ROUTE_PATHS.profileDelete}`,
    providerDefault: `${PLUGIN_BASE}${PROVIDER_ROUTE_PATHS.defaultProfile}`,
    providerSecret: `${PLUGIN_BASE}${PROVIDER_ROUTE_PATHS.secret}`,
    providerProfileTest: `${PLUGIN_BASE}${PROVIDER_ROUTE_PATHS.profileTest}`,
    providerComfyAnalyze: `${PLUGIN_BASE}${PROVIDER_ROUTE_PATHS.comfyAnalyze}`,
    diagnosticsRecent: `${PLUGIN_BASE}/diagnostics/recent`,
    diagnosticsClear: `${PLUGIN_BASE}/diagnostics/clear`,
});

let initialized = false;
let context;
let settings;
let observer;
let renderQueued = false;
let promptIsArmed = false;
let providerConfig = { profiles: [], defaultProfile: '' };
let providerOriginalName = '';
let comfyWorkflow = null;
let comfyWorkflowName = '';
let comfyCandidates = Object.fromEntries(COMFY_BINDING_KEYS.map(key => [key, []]));
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

function clearLegacyProjectionMetadata(message) {
    if (!message?.extra) return;
    const ownsDisplay = message.extra.image_schema_display_text !== undefined
        && message.extra.display_text === message.extra.image_schema_display_text;
    if (ownsDisplay) {
        if (message.extra.image_schema_previous_display_text === undefined) delete message.extra.display_text;
        else message.extra.display_text = message.extra.image_schema_previous_display_text;
    }
    delete message.extra.image_schema_original;
    delete message.extra.image_schema_display_text;
    delete message.extra.image_schema_previous_display_text;
}

function prepareMessageProjection(messageId) {
    const message = context.chat?.[Number(messageId)];
    if (!message || message.is_user || message.is_system) return { text: String(message?.mes ?? ''), occurrences: [] };
    // Older builds persisted derived projection data into per-swipe `extra`.
    // Remove it once, then keep all projection state ephemeral and derived only
    // from the currently active swipe's canonical `message.mes` string.
    clearLegacyProjectionMetadata(message);
    const source = String(message.mes ?? '');
    if (!settings.enabled) return { text: source, occurrences: [] };
    return projectSchemas(source, settings, { urlForRequest: pluginImageUrl });
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

function imageFailureLabel(image) {
    const code = image.dataset.imageError || '';
    if (code === 'safety' || code === 'rate_limit' || code === 'invalid_request') return 'Rejected prompt';
    return 'Image generation failed';
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
    if (image.dataset.imageSchemaListeners !== 'true') {
        image.dataset.imageSchemaListeners = 'true';
        image.addEventListener('load', () => {
            image.classList.add('image-schema-loaded');
            state.textContent = '';
        });
        image.addEventListener('error', () => {
            image.classList.remove('image-schema-loaded');
            if (!image.classList.contains('image-schema-failed')) state.textContent = `${imageFailureLabel(image)}. Check Plugin activity for details.`;
        });
    }
    if (image.complete && image.naturalWidth > 0) {
        image.classList.add('image-schema-loaded');
        state.textContent = '';
    }

    if (frame.querySelector('.image-schema-actions')) return;
    const actions = document.createElement('span');
    actions.className = 'image-schema-actions';
    const controls = [
        ['image-schema-copy', 'Copy image prompt', 'fa-copy'],
        ['image-schema-inspect', 'Inspect effective request', 'fa-circle-info'],
        ['image-schema-regenerate', 'Regenerate with a fresh seed', 'fa-dice'],
    ];
    for (const [className, title, iconName] of controls) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `menu_button ${className}`;
        button.title = title;
        button.dataset.swipeIgnore = 'true';
        const icon = document.createElement('i');
        icon.className = `fa-solid ${iconName}`;
        icon.dataset.swipeIgnore = 'true';
        button.append(icon);
        actions.append(button);
    }
    frame.append(actions);

    actions.addEventListener('pointerdown', event => event.stopPropagation());
    actions.addEventListener('touchstart', event => event.stopPropagation(), { passive: true });
    actions.querySelector('.image-schema-copy').addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        await navigator.clipboard.writeText(request.text);
        notify('success', 'Image prompt copied.');
    });
    actions.querySelector('.image-schema-inspect').addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        window.alert(JSON.stringify(request, null, 2));
    });
    actions.querySelector('.image-schema-regenerate').addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
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
    const byKey = new Map(occurrences.filter(item => item.key).map(item => [item.key, item]));
    const candidates = Array.from(root.querySelectorAll('img'));
    let occurrenceNumber = 0;
    for (const image of candidates) {
        const rawSource = image.getAttribute('src') || '';
        const projectedKey = image.getAttribute('data-image-schema-key');
        const projected = projectedKey ? byKey.get(projectedKey) : null;
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
    // During an overswipe ST creates a temporary slot and shows `...` before
    // generation starts. Do not replace that placeholder with the prior swipe.
    if (typeof message.swipe_id === 'number' && Array.isArray(message.swipes) && message.swipe_id >= message.swipes.length) return;
    const messageElement = getMessageElement(id);
    const textElement = messageElement?.querySelector('.mes_text');
    if (!textElement) return;

    const projection = prepareMessageProjection(id);
    if (!settings.enabled) return;

    // Preserve ST's core message node and swipe controls. Only replace the
    // contents when this active swipe actually has a schema and the matching
    // ephemeral projection is not already present.
    const expectedKeys = projection.occurrences.filter(item => item.request).map(item => item.key).filter(Boolean);
    const renderedKeys = new Set(Array.from(textElement.querySelectorAll('[data-image-schema-key]')).map(node => node.getAttribute('data-image-schema-key')));
    const projectionPresent = expectedKeys.length > 0 && expectedKeys.every(key => renderedKeys.has(key));
    if (projection.occurrences.length > 0 && !projectionPresent) {
        textElement.innerHTML = context.messageFormatting(
            projection.text,
            message.name,
            Boolean(message.is_system),
            Boolean(message.is_user),
            id,
            {},
            false,
        );
    }
    rewriteImages(textElement, projection.occurrences, id);
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
    const messageIds = new Set();
    for (const record of records) {
        for (const node of record.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            if (node.matches?.('.mes[mesid]')) messageIds.add(node.getAttribute('mesid'));
        }
    }
    for (const messageId of messageIds) requestAnimationFrame(() => renderMessage(messageId));
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
    listen(events.CHARACTER_MESSAGE_RENDERED, renderMessage);
    listen(events.MESSAGE_UPDATED, renderMessage);
    // MESSAGE_EDITED fires while ST's textarea/editor DOM still exists. Wait for
    // MESSAGE_UPDATED rather than replacing the editor subtree mid-edit.
    // Swipe rendering is completed by SillyTavern before MESSAGE_SWIPED. Defer
    // our DOM decoration until its swipe transition call stack has yielded.
    listen(events.MESSAGE_SWIPED, messageId => requestAnimationFrame(() => renderMessage(messageId)));
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

function setProviderResult(value) {
    const output = document.getElementById('image_schema_provider_result');
    if (!output) return;
    output.textContent = typeof value === 'string' ? value : JSON.stringify(redactSensitiveValue(value), null, 2);
}

const COMFY_BINDING_CONTROLS = Object.freeze({
    positivePrompt: 'image_schema_comfy_binding_positive',
    negativePrompt: 'image_schema_comfy_binding_negative',
    seed: 'image_schema_comfy_binding_seed',
    width: 'image_schema_comfy_binding_width',
    height: 'image_schema_comfy_binding_height',
    outputNode: 'image_schema_comfy_binding_output',
});

function comfyBindingToken(binding) {
    return binding ? JSON.stringify({ node: binding.node, input: binding.input || '' }) : '';
}

function readComfyBinding(key) {
    const raw = value(COMFY_BINDING_CONTROLS[key]);
    if (!raw) return null;
    try { return normalizeComfyBinding(JSON.parse(raw)); } catch { return null; }
}

function comfyBindingsFromForm() {
    return Object.fromEntries(COMFY_BINDING_KEYS.map(key => [key, readComfyBinding(key)]));
}

function formatComfyBinding(binding) {
    const coordinate = `${binding.node}${binding.input ? ` · ${binding.input}` : ''}`;
    const confidence = Number.isFinite(binding.confidence) ? ` · ${Math.round(binding.confidence * 100)}%` : '';
    const warning = binding.warning ? ' ⚠' : '';
    return `${binding.label || coordinate}${confidence}${warning}`;
}

function populateComfyBindingSelect(key, selected = null) {
    const select = document.getElementById(COMFY_BINDING_CONTROLS[key]);
    if (!(select instanceof HTMLSelectElement)) return;
    const candidates = comfyCandidates[key] || [];
    select.replaceChildren();
    if (key !== 'positivePrompt') {
        const none = document.createElement('option');
        none.value = '';
        none.textContent = 'None';
        select.append(none);
    } else if (!candidates.length && !selected) {
        const missing = document.createElement('option');
        missing.value = '';
        missing.textContent = 'No candidates — analyze workflow';
        select.append(missing);
    }
    const selectedBinding = normalizeComfyBinding(selected);
    const merged = [...candidates];
    if (selectedBinding && !merged.some(candidate => comfyBindingToken(candidate) === comfyBindingToken(selectedBinding))) merged.unshift(selectedBinding);
    for (const binding of merged) {
        const option = document.createElement('option');
        option.value = comfyBindingToken(binding);
        option.textContent = formatComfyBinding(binding);
        option.title = [binding.path, binding.warning].filter(Boolean).join(' — ');
        select.append(option);
    }
    const selectedToken = comfyBindingToken(selectedBinding);
    if (selectedToken && Array.from(select.options).some(option => option.value === selectedToken)) select.value = selectedToken;
    else if (candidates.length) select.value = comfyBindingToken(candidates[0]);
    else select.value = '';
}

function updateComfyValidation(message = '') {
    const validation = document.getElementById('image_schema_comfy_validation');
    if (!validation) return;
    const positive = readComfyBinding('positivePrompt');
    const valid = Boolean(comfyWorkflow && positive?.input);
    const stateMessage = valid
        ? 'Ready to save. Positive prompt is bound.'
        : !comfyWorkflow ? 'Load an API workflow JSON file.' : 'Select the required positive prompt binding.';
    validation.dataset.state = valid ? 'ok' : 'error';
    validation.textContent = [message, stateMessage].filter(Boolean).join(' ');
}

function updateComfyWorkflowStatus(error = '') {
    const status = document.getElementById('image_schema_comfy_workflow_status');
    if (!status) return;
    if (error) {
        status.dataset.state = 'error';
        status.textContent = error;
    } else if (comfyWorkflow) {
        status.dataset.state = 'ok';
        status.textContent = `${comfyWorkflowName || 'Workflow JSON'} · ${countComfyWorkflowNodes(comfyWorkflow)} node(s) · loaded`;
    } else {
        status.dataset.state = 'empty';
        status.textContent = 'No workflow loaded.';
    }
}

function resetComfyCandidates(bindings = {}) {
    comfyCandidates = Object.fromEntries(COMFY_BINDING_KEYS.map(key => [key, []]));
    for (const key of COMFY_BINDING_KEYS) populateComfyBindingSelect(key, bindings[key]);
    updateComfyValidation();
}

async function importComfyWorkflow(event) {
    const file = event.currentTarget?.files?.[0];
    if (!file) return;
    try {
        comfyWorkflow = parseComfyWorkflow(await file.text());
        comfyWorkflowName = file.name;
        comfyCandidates = inferComfyWorkflowCandidates(comfyWorkflow);
        updateComfyWorkflowStatus();
        for (const key of COMFY_BINDING_KEYS) populateComfyBindingSelect(key);
        updateComfyValidation('Workflow parsed locally. Analyze it for server-assisted binding discovery.');
        setProviderResult('Workflow parsed locally. Analyze it to confirm bindings against the configured ComfyUI server.');
    } catch (error) {
        comfyWorkflow = null;
        comfyWorkflowName = '';
        updateComfyWorkflowStatus(error.message);
        resetComfyCandidates();
        setProviderResult(error.message);
    } finally {
        event.currentTarget.value = '';
    }
}

function clearComfyWorkflow() {
    comfyWorkflow = null;
    comfyWorkflowName = '';
    updateComfyWorkflowStatus();
    resetComfyCandidates();
    setProviderResult('Workflow removed from this unsaved profile.');
}

async function analyzeComfyWorkflow() {
    try {
        if (!comfyWorkflow) throw new Error('Load an API workflow JSON file before analyzing');
        setProviderResult('Analyzing workflow structure…');
        const url = resolveProviderUrl('comfyui', value('image_schema_provider_url'));
        if (!url) throw new Error('ComfyUI server URL is required before analyzing');
        const result = await pluginFetch(ROUTES.providerComfyAnalyze, {
            method: 'POST',
            body: JSON.stringify({ url, workflow: comfyWorkflow }),
        });
        const analysis = result?.analysis || result;
        comfyCandidates = mergeComfyCandidates(normalizeComfyCandidates(analysis), inferComfyWorkflowCandidates(comfyWorkflow));
        for (const key of COMFY_BINDING_KEYS) populateComfyBindingSelect(key);
        const issues = [
            ...(!comfyCandidates.positivePrompt.length ? ['No positive prompt binding candidate was found.'] : []),
            ...(analysis?.missingClassTypes?.length ? [`Missing node classes: ${analysis.missingClassTypes.join(', ')}`] : []),
            ...(analysis?.warnings || []),
        ];
        const message = issues.length ? 'Analysis completed with issues.' : 'Analysis complete. Review the selected bindings.';
        updateComfyValidation(issues.length ? `${message} ${issues.join(' ')}` : message);
        setProviderResult({ message, nodeCount: analysis?.nodeCount ?? countComfyWorkflowNodes(comfyWorkflow), warnings: issues });
    } catch (error) {
        updateComfyValidation(error.message);
        setProviderResult(error.message);
        notify('error', error.message);
    }
}

function providerPayload() {
    const type = value('image_schema_provider_type');
    const common = {
        name: value('image_schema_provider_name'),
        type,
        url: value('image_schema_provider_url'),
        timeoutMs: Number(value('image_schema_provider_timeout')),
    };
    if (type === 'comfyui') return buildProviderProfilePayload({
        ...common,
        workflow: comfyWorkflow,
        bindings: comfyBindingsFromForm(),
    });
    return buildProviderProfilePayload({
        ...common,
        model: value('image_schema_provider_model'),
        allowedModels: parseAllowedModels(value('image_schema_provider_allowed_models')),
        defaults: parseProviderDefaults(value('image_schema_provider_defaults')),
        method: type === 'generic' ? normalizeGenericMethod(value('image_schema_provider_method')) : undefined,
    });
}

function changeProviderType() {
    const type = value('image_schema_provider_type');
    if (type === 'comfyui') {
        comfyWorkflow = null;
        comfyWorkflowName = '';
        updateComfyWorkflowStatus();
        resetComfyCandidates();
        setProviderResult('Upload an API workflow for this ComfyUI profile.');
    }
    updateProviderPanels();
}

function updateProviderPanels() {
    const type = value('image_schema_provider_type');
    document.querySelectorAll('[data-image-schema-provider-panel]').forEach(panel => {
        panel.classList.toggle('displayNone', panel.getAttribute('data-image-schema-provider-panel') !== type);
    });
    const isComfy = type === 'comfyui';
    document.getElementById('image_schema_provider_test')?.classList.toggle('displayNone', isComfy);
    document.getElementById('image_schema_provider_model_field')?.classList.toggle('displayNone', isComfy);
    document.getElementById('image_schema_provider_secret_panel')?.classList.toggle('displayNone', isComfy);
    document.getElementById('image_schema_provider_advanced')?.classList.toggle('displayNone', isComfy);
    const label = document.getElementById('image_schema_provider_url_label');
    const help = document.getElementById('image_schema_provider_url_help');
    const preview = document.getElementById('image_schema_provider_url_preview');
    if (label) label.textContent = type === 'openai' ? 'API base URL or generations endpoint' : type === 'gemini-sse' ? 'API base URL or stream endpoint' : isComfy ? 'ComfyUI server URL' : 'Provider URL';
    if (help) help.textContent = type === 'openai'
        ? 'A base URL automatically uses /v1/images/generations. A complete generations endpoint is preserved.'
        : type === 'gemini-sse' ? 'Gemini 3 image models use /v1beta/interactions. Older image models use streamGenerateContent. Complete endpoints are preserved.'
            : isComfy ? 'Enter the ComfyUI server base URL. Model, VAE, LoRA, sampler, and other generation settings remain owned by the workflow.' : 'Enter the complete generic request URL.';
    if (preview) {
        try {
            const resolved = resolveProviderUrl(type, value('image_schema_provider_url'), value('image_schema_provider_model'));
            preview.textContent = resolved ? `Effective endpoint: ${resolved}` : '';
            preview.dataset.state = 'ok';
        } catch (error) {
            preview.textContent = value('image_schema_provider_url') ? error.message : '';
            preview.dataset.state = 'error';
        }
    }
}

function updateProviderSecretStatus(configured) {
    const status = document.getElementById('image_schema_provider_key_status');
    if (!status) return;
    status.dataset.state = configured ? 'ok' : 'checking';
    status.textContent = configured ? 'API key configured' : 'No API key configured';
}

function populateProviderEditor(profileInput) {
    const profile = normalizeProviderProfile(profileInput);
    providerOriginalName = profile.name;
    setValue('image_schema_provider_name', profile.name);
    setValue('image_schema_provider_type', profile.type);
    setValue('image_schema_provider_url', displayProviderUrl(profile.type, profile.url));
    setValue('image_schema_provider_method', profile.method || 'POST');
    setValue('image_schema_provider_model', profile.model);
    setValue('image_schema_provider_allowed_models', profile.allowedModels.join('\n'));
    setValue('image_schema_provider_timeout', profile.timeoutMs);
    setValue('image_schema_provider_defaults', serializeProviderDefaults(profile.defaults));
    setValue('image_schema_provider_key', '');
    setChecked('image_schema_provider_make_default', profile.name !== '' && profile.name === providerConfig.defaultProfile);
    comfyWorkflow = profile.workflow ? structuredClone(profile.workflow) : null;
    comfyWorkflowName = profile.workflowName || (comfyWorkflow && profile.name ? `${profile.name} workflow` : '');
    resetComfyCandidates(profile.bindings);
    updateComfyWorkflowStatus();
    updateProviderSecretStatus(profile.apiKeyConfigured);
    updateProviderPanels();
    if (profile.type === 'comfyui') updateComfyValidation();
}

function renderProviderSelector(selectedName = '') {
    const selector = document.getElementById('image_schema_provider_profile');
    if (!(selector instanceof HTMLSelectElement)) return;
    selector.replaceChildren();
    if (!providerConfig.profiles.length) {
        const empty = document.createElement('option');
        empty.value = '';
        empty.textContent = 'No profiles configured';
        selector.append(empty);
        populateProviderEditor({});
        return;
    }
    for (const profile of providerConfig.profiles) {
        const option = document.createElement('option');
        option.value = profile.name;
        option.textContent = profile.name === providerConfig.defaultProfile ? `${profile.name} (default)` : profile.name;
        selector.append(option);
    }
    const selected = providerConfig.profiles.find(profile => profile.name === selectedName)
        || providerConfig.profiles.find(profile => profile.name === providerConfig.defaultProfile)
        || providerConfig.profiles[0];
    selector.value = selected.name;
    populateProviderEditor(selected);
}

async function refreshProviders(selectedName = '') {
    setProviderResult('Loading provider profiles…');
    try {
        providerConfig = normalizeProviderConfig(await pluginFetch(ROUTES.providerConfig));
        renderProviderSelector(selectedName);
        setProviderResult(`${providerConfig.profiles.length} provider profile(s) loaded.`);
        return providerConfig;
    } catch (error) {
        setProviderResult(`Provider profiles unavailable: ${error.message}`);
        throw error;
    }
}

function selectProvider() {
    const selected = providerConfig.profiles.find(profile => profile.name === value('image_schema_provider_profile'));
    if (selected) populateProviderEditor(selected);
}

function addProvider() {
    populateProviderEditor({ name: '', type: 'openai', timeoutMs: 120000, defaults: {} });
    setProviderResult('Enter a unique profile name and provider settings.');
}

function duplicateProvider() {
    const selected = providerConfig.profiles.find(profile => profile.name === value('image_schema_provider_profile'));
    if (!selected) return addProvider();
    populateProviderEditor({ ...structuredClone(selected), name: `${selected.name}-copy`, apiKeyConfigured: false });
    setProviderResult('Profile fields duplicated. Secrets are not copied.');
}

async function saveProvider() {
    try {
        const profile = providerPayload();
        const result = await pluginFetch(ROUTES.providerProfileSave, {
            method: 'POST',
            body: JSON.stringify({ profile, previousName: providerOriginalName || undefined }),
        });
        if (checked('image_schema_provider_make_default')) {
            await pluginFetch(ROUTES.providerDefault, { method: 'POST', body: JSON.stringify({ name: profile.name }) });
        }
        setProviderResult(result);
        notify('success', `Provider profile “${profile.name}” saved.`);
        await refreshProviders(profile.name);
    } catch (error) {
        setProviderResult(error.message);
        notify('error', error.message);
    }
}

async function deleteProvider() {
    const name = providerOriginalName || value('image_schema_provider_name').trim();
    if (!name || !window.confirm(`Delete provider profile “${name}”?`)) return;
    try {
        const result = await pluginFetch(ROUTES.providerProfileDelete, { method: 'POST', body: JSON.stringify({ name }) });
        setProviderResult(result);
        notify('success', `Provider profile “${name}” deleted.`);
        await refreshProviders();
    } catch (error) {
        setProviderResult(error.message);
        notify('error', error.message);
    }
}

async function setDefaultProvider() {
    const name = providerOriginalName || value('image_schema_provider_name').trim();
    if (!name) return notify('error', 'Save or select a provider profile first.');
    try {
        const result = await pluginFetch(ROUTES.providerDefault, { method: 'POST', body: JSON.stringify({ name }) });
        setProviderResult(result);
        notify('success', `Default provider set to “${name}”.`);
        await refreshProviders(name);
    } catch (error) {
        setProviderResult(error.message);
        notify('error', error.message);
    }
}

async function replaceProviderSecret() {
    const name = providerOriginalName || value('image_schema_provider_name').trim();
    const apiKey = value('image_schema_provider_key');
    if (!name) return notify('error', 'Save or select a provider profile first.');
    if (!apiKey) return notify('error', 'Enter a replacement API key.');
    try {
        const result = await pluginFetch(ROUTES.providerSecret, { method: 'POST', body: JSON.stringify({ name, apiKey }) });
        setValue('image_schema_provider_key', '');
        updateProviderSecretStatus(true);
        setProviderResult(result);
        notify('success', `API key for “${name}” replaced.`);
    } catch (error) {
        setValue('image_schema_provider_key', '');
        setProviderResult(error.message);
        notify('error', error.message);
    }
}

async function clearProviderSecret() {
    const name = providerOriginalName || value('image_schema_provider_name').trim();
    if (!name || !window.confirm(`Clear the API key for “${name}”?`)) return;
    try {
        const result = await pluginFetch(ROUTES.providerSecret, { method: 'POST', body: JSON.stringify({ name, clear: true }) });
        setValue('image_schema_provider_key', '');
        updateProviderSecretStatus(false);
        setProviderResult(result);
        notify('success', `API key for “${name}” cleared.`);
    } catch (error) {
        setProviderResult(error.message);
        notify('error', error.message);
    }
}

async function testProvider() {
    try {
        const profile = providerPayload();
        setProviderResult('Testing provider profile…');
        const result = await pluginFetch(ROUTES.providerProfileTest, { method: 'POST', body: JSON.stringify({ profile }) });
        setProviderResult(result);
        notify('success', `Provider profile “${profile.name}” test completed.`);
    } catch (error) {
        setProviderResult(error.message);
        notify('error', error.message);
    }
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

async function refreshPluginDiagnostics() {
    const output = document.getElementById('image_schema_diagnostics_output');
    try {
        const result = await pluginFetch(`${ROUTES.diagnosticsRecent}?limit=100`);
        if (output) output.textContent = JSON.stringify(result, null, 2);
    } catch (error) {
        if (output) output.textContent = `Diagnostics unavailable: ${error.message}`;
    }
}

async function clearPluginDiagnostics() {
    if (!window.confirm('Clear recorded plugin activity?')) return;
    try {
        await pluginFetch(ROUTES.diagnosticsClear, { method: 'POST', body: JSON.stringify({ scope: 'user' }) });
        await refreshPluginDiagnostics();
        notify('success', 'Plugin activity cleared.');
    } catch (error) {
        notify('error', error.message);
    }
}

async function addSettingsUi() {
    if (document.getElementById('image_schema_settings')) return;
    const response = await fetch(new URL('./settings.html', import.meta.url));
    if (!response.ok) throw new Error(`Could not load Image Schema settings: ${response.status}`);
    const template = document.createElement('template');
    const documentFragment = document.createRange().createContextualFragment(await response.text());
    template.content.append(documentFragment);
    const root = template.content.firstElementChild;
    const target = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!root || !target) throw new Error('SillyTavern extension settings container was not found');
    target.append(root);
    populateSettingsForm();

    root.querySelectorAll('input, select, textarea').forEach(element => {
        if (element.closest('#image_schema_provider_editor') || element.id === 'image_schema_provider_profile') return;
        if (element.id === 'image_schema_test_input' || element.id === 'image_schema_test_prompt') return;
        element.addEventListener(element instanceof HTMLSelectElement ? 'change' : 'input', readSettingsForm);
    });
    document.getElementById('image_schema_copy_instruction')?.addEventListener('click', copyInstruction);
    document.getElementById('image_schema_check_plugin')?.addEventListener('click', () => checkPluginStatus().catch(error => notify('error', error.message)));
    document.getElementById('image_schema_test_parser')?.addEventListener('click', testParser);
    document.getElementById('image_schema_test_generation')?.addEventListener('click', testGeneration);
    document.getElementById('image_schema_refresh_cache')?.addEventListener('click', refreshCacheStats);
    document.getElementById('image_schema_clear_cache')?.addEventListener('click', clearCache);
    document.getElementById('image_schema_diagnostics_refresh')?.addEventListener('click', refreshPluginDiagnostics);
    document.getElementById('image_schema_diagnostics_clear')?.addEventListener('click', clearPluginDiagnostics);
    document.getElementById('image_schema_provider_profile')?.addEventListener('change', selectProvider);
    document.getElementById('image_schema_provider_refresh')?.addEventListener('click', () => refreshProviders(providerOriginalName).catch(error => notify('error', error.message)));
    document.getElementById('image_schema_provider_add')?.addEventListener('click', addProvider);
    document.getElementById('image_schema_provider_duplicate')?.addEventListener('click', duplicateProvider);
    document.getElementById('image_schema_provider_delete')?.addEventListener('click', deleteProvider);
    document.getElementById('image_schema_provider_type')?.addEventListener('change', changeProviderType);
    document.getElementById('image_schema_provider_url')?.addEventListener('input', updateProviderPanels);
    document.getElementById('image_schema_provider_model')?.addEventListener('input', updateProviderPanels);
    document.getElementById('image_schema_comfy_workflow_choose')?.addEventListener('click', () => document.getElementById('image_schema_comfy_workflow_file')?.click());
    document.getElementById('image_schema_comfy_workflow_file')?.addEventListener('change', importComfyWorkflow);
    document.getElementById('image_schema_comfy_workflow_clear')?.addEventListener('click', clearComfyWorkflow);
    document.getElementById('image_schema_comfy_analyze')?.addEventListener('click', analyzeComfyWorkflow);
    for (const id of Object.values(COMFY_BINDING_CONTROLS)) document.getElementById(id)?.addEventListener('change', () => updateComfyValidation());
    document.getElementById('image_schema_provider_save')?.addEventListener('click', saveProvider);
    document.getElementById('image_schema_provider_set_default')?.addEventListener('click', setDefaultProvider);
    document.getElementById('image_schema_provider_key_replace')?.addEventListener('click', replaceProviderSecret);
    document.getElementById('image_schema_provider_key_clear')?.addEventListener('click', clearProviderSecret);
    document.getElementById('image_schema_provider_test')?.addEventListener('click', testProvider);
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
        observer.observe(chat, { childList: true, subtree: false });
    }
    queueRenderAll();
    checkPluginStatus().catch(() => {});
    refreshProviders().catch(() => {});
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
        for (const message of context.chat) clearLegacyProjectionMetadata(message);
    }
    comfyWorkflow = null;
    comfyWorkflowName = '';
    comfyCandidates = Object.fromEntries(COMFY_BINDING_KEYS.map(key => [key, []]));
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
