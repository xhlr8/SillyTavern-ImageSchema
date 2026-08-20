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
    formatEffectiveRequest,
    parseStoredImageRequest,
    withFreshSeed,
    withRefreshToken,
} from './image-ui.js';
import {
    COMFY_BINDING_KEYS,
    PROVIDER_ROUTE_PATHS,
    buildProviderProfilePayload,
    chooseComfyBinding,
    countComfyWorkflowNodes,
    enumerateComfyWorkflowCandidates,
    formatComfyBindingHelp,
    formatComfyBindingLabel,
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
    selectInstructionProviderProfile,
} from './provider.js';

const MODULE_NAME = 'imageSchema';
const PROMPT_KEY = 'image-schema-instruction';
const GLOBAL_SCHEMA_MACRO = 'globalschemaprompt';
const PLUGIN_BASE = '/api/plugins/image-schema';
const PROJECTED_IMAGE_PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
export const ROUTES = Object.freeze({
    status: `${PLUGIN_BASE}/status`,
    test: `${PLUGIN_BASE}/test`,
    image: `${PLUGIN_BASE}/image/`,
    cacheStats: `${PLUGIN_BASE}/cache/stats`,
    cacheClear: `${PLUGIN_BASE}/cache/clear`,
    outputsStats: `${PLUGIN_BASE}/outputs/stats`,
    outputsClear: `${PLUGIN_BASE}/outputs/clear`,
    providerConfig: `${PLUGIN_BASE}${PROVIDER_ROUTE_PATHS.config}`,
    providerProfileSave: `${PLUGIN_BASE}${PROVIDER_ROUTE_PATHS.profileSave}`,
    providerProfileDelete: `${PLUGIN_BASE}${PROVIDER_ROUTE_PATHS.profileDelete}`,
    providerDefault: `${PLUGIN_BASE}${PROVIDER_ROUTE_PATHS.defaultProfile}`,
    providerRouting: `${PLUGIN_BASE}/providers/routing`,
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
    // Formatting receives a harmless placeholder so inserting the projected
    // markup cannot race a direct <img> request against the status-aware fetch.
    return projectSchemas(source, settings, { urlForRequest: () => PROJECTED_IMAGE_PLACEHOLDER });
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
        const detail = typeof body === 'string'
            ? body
            : body?.error?.message ?? body?.message ?? body?.error?.code ?? JSON.stringify(body);
        throw new Error(`${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`);
    }
    return body;
}

export async function fetchImageResource(source, fetchImpl = fetch, signal) {
    const response = await fetchImpl(source, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: requestHeaders(),
        signal,
    });
    const errorCode = response.headers.get('x-image-error') || '';
    const cache = response.headers.get('x-image-cache') || (errorCode ? 'ERROR' : '');
    if (!response.ok) {
        const detail = (await response.text().catch(() => '')).trim();
        throw new Error(`${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`);
    }
    return {
        blob: await response.blob(),
        errorCode,
        cache,
        profile: response.headers.get('x-image-profile') || '',
        requestedProfile: response.headers.get('x-image-requested-profile') || '',
        fallbackReason: response.headers.get('x-image-fallback-reason') || '',
    };
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

function stopImageInteraction(event) {
    event.stopPropagation();
}

function makeImageButton(className, label, iconName, { compact = false } = {}) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `menu_button ${className}${compact ? ' image-schema-compact-control' : ''}`;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.dataset.swipeIgnore = 'true';
    const icon = document.createElement('i');
    icon.className = `fa-solid ${iconName}`;
    icon.setAttribute('aria-hidden', 'true');
    icon.dataset.swipeIgnore = 'true';
    button.append(icon);
    return button;
}

function currentRenderedImage(reference) {
    if (reference?.isConnected) return reference;
    const messageId = reference?.dataset.imageSchemaMessage;
    const occurrence = reference?.dataset.imageSchemaOccurrence;
    if (messageId === undefined || occurrence === undefined) return null;
    return document.querySelector(
        `.image-schema-image[data-image-schema-message="${CSS.escape(messageId)}"][data-image-schema-occurrence="${CSS.escape(occurrence)}"]`,
    );
}

function getImageRequest(image) {
    return parseStoredImageRequest(currentRenderedImage(image)?.dataset.imageSchemaRequest);
}

async function copyImagePrompt(image) {
    const request = getImageRequest(image);
    if (!request) return notify('error', 'The current image request is unavailable.');
    try {
        await navigator.clipboard.writeText(request.text);
        notify('success', 'Image prompt copied.');
    } catch (error) {
        notify('error', `Could not copy the image prompt: ${error.message}`);
    }
}

function showRequestInspector(request) {
    const current = request || null;
    const popupContent = document.createElement('section');
    popupContent.className = 'image-schema-inspector';
    popupContent.dataset.swipeIgnore = 'true';
    const heading = document.createElement('h3');
    heading.textContent = 'Effective image request';
    const output = document.createElement('pre');
    output.className = 'image-schema-request-output';
    output.textContent = formatEffectiveRequest(current);
    popupContent.append(heading, output);

    if (context?.Popup && context?.POPUP_TYPE) {
        const popup = new context.Popup(popupContent, context.POPUP_TYPE.TEXT, '', {
            okButton: 'Close',
            wide: true,
            allowVerticalScrolling: true,
            allowHorizontalScrolling: false,
            leftAlign: true,
        });
        popup.dlg.classList.add('image-schema-inspector-dialog');
        void popup.show();
    } else {
        window.alert(output.textContent);
    }
}

function regenerateImage(reference, onUpdated) {
    const image = currentRenderedImage(reference);
    const request = getImageRequest(image);
    if (!image || !request) {
        notify('error', 'The image is no longer present in the current message.');
        return null;
    }

    const next = withFreshSeed(request);
    const nextSource = withRefreshToken(pluginImageUrl(next));
    const state = image.closest('.image-schema-frame')?.querySelector('.image-schema-state');
    image.classList.remove('image-schema-loaded', 'image-schema-failed');
    image.removeAttribute('title');
    image.alt = request.text;
    image.dataset.imageSchemaRequest = JSON.stringify(next);
    void loadImageResource(image, nextSource, state).then(result => {
        if (result) onUpdated?.({ image, request: next, source: result.source, result });
    });
    if (state) state.textContent = 'Regenerating image with a fresh seed…';
    return next;
}

function settledImageStatus(image) {
    if (image.dataset.imageError) {
        return `${imageFailureLabel(image)} · ${image.dataset.imageError}${image.dataset.imageProfile ? ` · ${image.dataset.imageProfile}` : ''}`;
    }
    const usedFallback = image.dataset.imageFallbackReason && image.dataset.imageProfile !== image.dataset.imageRequestedProfile;
    return usedFallback
        ? `Loaded · ${image.dataset.imageCache || 'MISS'} · fallback ${image.dataset.imageProfile} (${image.dataset.imageFallbackReason})`
        : ['Loaded', image.dataset.imageCache, image.dataset.imageProfile].filter(Boolean).join(' · ');
}

function openImageLightbox(reference) {
    const image = currentRenderedImage(reference);
    const request = getImageRequest(image);
    if (!image || !request) return;

    const root = document.createElement('section');
    root.className = 'image-schema-lightbox';
    root.dataset.swipeIgnore = 'true';

    const largeImage = document.createElement('img');
    largeImage.className = 'img_enlarged image-schema-lightbox-image';
    largeImage.src = image.currentSrc || image.src;
    largeImage.alt = image.alt || request.text;
    largeImage.dataset.swipeIgnore = 'true';
    const imageHolder = document.createElement('div');
    imageHolder.className = 'img_enlarged_holder image-schema-lightbox-holder';
    imageHolder.append(largeImage);
    const imageContainer = document.createElement('div');
    imageContainer.className = 'img_enlarged_container image-schema-lightbox-media';
    imageContainer.append(imageHolder);
    largeImage.addEventListener('click', event => {
        largeImage.classList.toggle('zoomed', !largeImage.classList.contains('zoomed'));
        event.stopPropagation();
    });

    const statusOutput = document.createElement('div');
    statusOutput.className = 'image-schema-lightbox-status';
    statusOutput.textContent = settledImageStatus(image);

    const details = document.createElement('div');
    details.className = 'image-schema-lightbox-details';
    const promptLabel = document.createElement('div');
    promptLabel.className = 'image-schema-lightbox-label';
    promptLabel.textContent = 'Prompt';
    const promptOutput = document.createElement('div');
    promptOutput.className = 'image-schema-lightbox-prompt';
    promptOutput.textContent = request.text;
    const requestLabel = document.createElement('div');
    requestLabel.className = 'image-schema-lightbox-label';
    requestLabel.textContent = 'Effective request';
    const requestOutput = document.createElement('pre');
    requestOutput.className = 'image-schema-request-output image-schema-lightbox-request';
    requestOutput.textContent = formatEffectiveRequest(request);
    details.append(promptLabel, promptOutput, requestLabel, requestOutput);

    const controls = document.createElement('div');
    controls.className = 'image-schema-lightbox-controls';
    controls.dataset.swipeIgnore = 'true';
    const copyButton = makeImageButton('image-schema-lightbox-copy', 'Copy Prompt', 'fa-copy');
    const inspectButton = makeImageButton('image-schema-lightbox-inspect', 'Inspect', 'fa-circle-info');
    const regenerateButton = makeImageButton('image-schema-lightbox-regenerate', 'Regenerate Fresh Seed', 'fa-dice');
    const closeButton = makeImageButton('image-schema-lightbox-close', 'Close', 'fa-xmark');
    for (const [button, label] of [
        [copyButton, 'Copy Prompt'],
        [inspectButton, 'Inspect'],
        [regenerateButton, 'Regenerate Fresh Seed'],
        [closeButton, 'Close'],
    ]) {
        const text = document.createElement('span');
        text.textContent = label;
        text.dataset.swipeIgnore = 'true';
        button.append(text);
        controls.append(button);
    }
    root.append(statusOutput, imageContainer, details, controls);

    root.addEventListener('pointerdown', stopImageInteraction);
    root.addEventListener('touchstart', stopImageInteraction, { passive: true });
    root.addEventListener('click', stopImageInteraction);

    if (!context?.Popup || !context?.POPUP_TYPE) {
        showRequestInspector(request);
        return;
    }

    const popup = new context.Popup(root, context.POPUP_TYPE.DISPLAY, '', {
        large: true,
        transparent: true,
        allowVerticalScrolling: true,
        allowHorizontalScrolling: false,
        leftAlign: true,
    });
    popup.dlg.classList.add('image-schema-lightbox-dialog');
    popup.dlg.style.width = 'unset';
    popup.dlg.style.height = 'unset';
    popup.dlg.dataset.swipeIgnore = 'true';

    copyButton.addEventListener('click', event => {
        event.preventDefault();
        void copyImagePrompt(reference);
    });
    inspectButton.addEventListener('click', event => {
        event.preventDefault();
        const currentRequest = getImageRequest(reference);
        if (currentRequest) showRequestInspector(currentRequest);
    });
    regenerateButton.addEventListener('click', event => {
        event.preventDefault();
        statusOutput.textContent = 'Regenerating image with a fresh seed…';
        regenerateImage(reference, ({ request: next, source }) => {
            largeImage.src = source;
            largeImage.alt = next.text;
            promptOutput.textContent = next.text;
            requestOutput.textContent = formatEffectiveRequest(next);
            statusOutput.textContent = settledImageStatus(image);
        });
    });
    closeButton.addEventListener('click', event => {
        event.preventDefault();
        void popup.completeCancelled();
    });
    void popup.show();
}

const imageObjectUrls = new WeakMap();
const imageLoadControllers = new WeakMap();
let imageLoadEpoch = 0;

function revokeImageObjectUrl(image) {
    const current = imageObjectUrls.get(image);
    if (!current) return;
    URL.revokeObjectURL(current);
    imageObjectUrls.delete(image);
}

function disposeImageResource(image) {
    imageLoadControllers.get(image)?.abort();
    imageLoadControllers.delete(image);
    image.dataset.imageSchemaLoadToken = String((Number(image.dataset.imageSchemaLoadToken) || 0) + 1);
    revokeImageObjectUrl(image);
}

function disposeImageResources(root) {
    const images = root?.matches?.('.image-schema-image')
        ? [root]
        : Array.from(root?.querySelectorAll?.('.image-schema-image') || []);
    images.forEach(disposeImageResource);
}

async function loadImageResource(image, source, state) {
    imageLoadControllers.get(image)?.abort();
    const controller = new AbortController();
    imageLoadControllers.set(image, controller);
    const epoch = imageLoadEpoch;
    const token = String((Number(image.dataset.imageSchemaLoadToken) || 0) + 1);
    image.dataset.imageSchemaLoadToken = token;
    image.dataset.imageSchemaSource = source;
    delete image.dataset.imageError;
    delete image.dataset.imageCache;
    delete image.dataset.imageProfile;
    delete image.dataset.imageRequestedProfile;
    delete image.dataset.imageFallbackReason;
    image.classList.remove('image-schema-loaded', 'image-schema-failed');
    if (state) state.textContent = 'Generating image…';
    try {
        const result = await fetchImageResource(source, fetch, controller.signal);
        if (epoch !== imageLoadEpoch || !image.isConnected || image.dataset.imageSchemaLoadToken !== token) return;
        revokeImageObjectUrl(image);
        const objectUrl = URL.createObjectURL(result.blob);
        imageObjectUrls.set(image, objectUrl);
        if (result.cache) image.dataset.imageCache = result.cache;
        if (result.profile) image.dataset.imageProfile = result.profile;
        if (result.requestedProfile) image.dataset.imageRequestedProfile = result.requestedProfile;
        if (result.fallbackReason) image.dataset.imageFallbackReason = result.fallbackReason;
        if (result.errorCode) {
            image.dataset.imageError = result.errorCode;
            image.classList.add('image-schema-failed');
            image.title = `${imageFailureLabel(image)} (${result.errorCode})`;
            if (state) state.textContent = `${imageFailureLabel(image)} · ${result.errorCode}. See Plugin activity.`;
        } else {
            const usedFallback = result.fallbackReason && result.profile && result.profile !== result.requestedProfile;
            const title = usedFallback
                ? `Generated by fallback profile ${result.profile} (${result.fallbackReason})`
                : [result.cache, result.profile].filter(Boolean).join(' · ');
            if (title) image.title = title;
            else image.removeAttribute('title');
        }
        image.src = objectUrl;
        return { ...result, source: objectUrl };
    } catch (error) {
        if (controller.signal.aborted || epoch !== imageLoadEpoch || !image.isConnected || image.dataset.imageSchemaLoadToken !== token) return;
        image.dataset.imageError = 'request_failed';
        image.classList.add('image-schema-failed');
        image.removeAttribute('src');
        image.title = error.message;
        if (state) state.textContent = `Image request failed: ${error.message}`;
    } finally {
        if (imageLoadControllers.get(image) === controller) imageLoadControllers.delete(image);
    }
}

function addImageControls(image, request, messageId, occurrence) {
    let frame = image.closest('.image-schema-frame');
    if (!frame) {
        frame = document.createElement('span');
        frame.className = 'image-schema-frame';
        frame.dataset.swipeIgnore = 'true';
        image.replaceWith(frame);
        frame.append(image);
    }
    image.classList.add('image-schema-image');
    image.dataset.imageSchema = 'true';
    image.dataset.imageSchemaMessage = String(messageId);
    image.dataset.imageSchemaOccurrence = String(occurrence);
    image.dataset.imageSchemaRequest = JSON.stringify(request);
    image.dataset.swipeIgnore = 'true';
    image.tabIndex = 0;
    image.setAttribute('role', 'button');
    image.setAttribute('aria-label', `Open generated image: ${request.text}`);

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
            image.classList.toggle('image-schema-loaded', !image.dataset.imageError);
            if (!image.dataset.imageError) state.textContent = '';
        });
        image.addEventListener('error', () => {
            image.classList.remove('image-schema-loaded');
            if (!image.classList.contains('image-schema-failed')) state.textContent = `${imageFailureLabel(image)}. Check Plugin activity for details.`;
        });
        image.addEventListener('pointerdown', stopImageInteraction);
        image.addEventListener('touchstart', stopImageInteraction, { passive: true });
        image.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            openImageLightbox(image);
        });
        image.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            event.stopPropagation();
            openImageLightbox(image);
        });
    }
    if (image.complete && image.naturalWidth > 0) {
        image.classList.add('image-schema-loaded');
        if (!image.dataset.imageError && !image.dataset.imageCache) state.textContent = '';
    }

    const existingActions = frame.querySelector('.image-schema-actions');
    if (!settings.showInlineControls) {
        existingActions?.remove();
        frame.querySelector('.image-schema-action-bar')?.remove();
        return;
    }
    if (existingActions) return;
    // Only the three requested buttons are created. When the global setting is
    // off, no inline action wrapper or hidden controls exist in the DOM.
    const actions = document.createElement('span');
    actions.className = 'image-schema-actions';
    actions.dataset.swipeIgnore = 'true';
    const controls = [
        ['image-schema-copy', 'Copy image prompt', 'fa-copy'],
        ['image-schema-inspect', 'Inspect effective request', 'fa-circle-info'],
        ['image-schema-regenerate', 'Regenerate with a fresh seed', 'fa-dice'],
    ];
    for (const [className, title, iconName] of controls) actions.append(makeImageButton(className, title, iconName));
    frame.append(actions);

    actions.addEventListener('pointerdown', stopImageInteraction);
    actions.addEventListener('touchstart', stopImageInteraction, { passive: true });
    actions.addEventListener('click', stopImageInteraction);
    actions.querySelector('.image-schema-copy').addEventListener('click', event => {
        event.preventDefault();
        void copyImagePrompt(image);
    });
    actions.querySelector('.image-schema-inspect').addEventListener('click', event => {
        event.preventDefault();
        const currentRequest = getImageRequest(image);
        if (currentRequest) showRequestInspector(currentRequest);
    });
    actions.querySelector('.image-schema-regenerate').addEventListener('click', event => {
        event.preventDefault();
        regenerateImage(image);
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
        const sameRenderedOccurrence = image.dataset.imageSchema === 'true'
            && image.dataset.imageSchemaMessage === String(messageId)
            && image.dataset.imageSchemaOccurrence === String(occurrenceNumber);
        const currentRequest = sameRenderedOccurrence ? parseStoredImageRequest(image.dataset.imageSchemaRequest) : null;
        const effectiveRequest = currentRequest || match.request;
        const source = pluginImageUrl(effectiveRequest);
        if (!sameRenderedOccurrence) image.removeAttribute('src');
        addImageControls(image, effectiveRequest, messageId, occurrenceNumber);
        if (!sameRenderedOccurrence) {
            const state = image.closest('.image-schema-frame')?.querySelector('.image-schema-state');
            void loadImageResource(image, source, state);
        }
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
    const renderedKeys = Array.from(textElement.querySelectorAll('[data-image-schema-key]')).map(node => node.getAttribute('data-image-schema-key'));
    const projectionPresent = expectedKeys.length > 0
        && expectedKeys.length === renderedKeys.length
        && expectedKeys.every((key, index) => key === renderedKeys[index]);
    if (projection.occurrences.length > 0 && !projectionPresent) {
        disposeImageResources(textElement);
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
        for (const node of record.removedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) disposeImageResources(node);
        }
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

function activeInstructionPrompt() {
    return selectInstructionProviderProfile(providerConfig, settings.defaults.backend)?.instructionPrompt || '';
}

function globalInstruction() {
    return buildInstruction(settings);
}

function currentInstruction() {
    return buildInstruction(settings, activeInstructionPrompt());
}

function registerGlobalSchemaMacro() {
    const macroApi = context?.macros;
    if (!macroApi?.register) return;
    macroApi.registry?.unregisterMacro?.(GLOBAL_SCHEMA_MACRO);
    macroApi.register(GLOBAL_SCHEMA_MACRO, {
        description: 'Expands to the current Image Schema Global Schema & Prompt instruction.',
        returns: 'The global Image Schema instruction without per-profile wrapping.',
        handler: () => globalInstruction(),
    });
}

function onGenerationAfterCommands(type, options, dryRun) {
    disarmPrompt();
    if (!shouldInject(type, options, dryRun)) return;
    context.setExtensionPrompt(PROMPT_KEY, currentInstruction(), 1, 0, false, 0);
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

function setText(id, input) {
    const element = document.getElementById(id);
    if (element) element.textContent = String(input ?? '');
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

const COMFY_BINDING_BROWSE_CONTROLS = Object.freeze(Object.fromEntries(COMFY_BINDING_KEYS.map(key => [key, `${COMFY_BINDING_CONTROLS[key]}_browse`])));
const COMFY_BINDING_HELP_CONTROLS = Object.freeze(Object.fromEntries(COMFY_BINDING_KEYS.map(key => [key, `${COMFY_BINDING_CONTROLS[key]}_help`])));

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

function updateComfyBindingHelp(key) {
    const help = document.getElementById(COMFY_BINDING_HELP_CONTROLS[key]);
    const select = document.getElementById(COMFY_BINDING_CONTROLS[key]);
    if (!help || !(select instanceof HTMLSelectElement)) return;
    const binding = readComfyBinding(key);
    const details = formatComfyBindingHelp(binding);
    help.textContent = details;
    help.title = details;
}

function populateComfyBindingSelect(key, selected = undefined) {
    const select = document.getElementById(COMFY_BINDING_CONTROLS[key]);
    if (!(select instanceof HTMLSelectElement)) return;
    const candidates = comfyCandidates[key] || [];
    const current = selected === undefined ? readComfyBinding(key) : normalizeComfyBinding(selected);
    const selectedBinding = chooseComfyBinding(comfyWorkflow, key, current, candidates);
    select.replaceChildren();
    if (key !== 'positivePrompt') {
        const none = document.createElement('option');
        none.value = '';
        none.textContent = 'None';
        select.append(none);
    } else if (!candidates.length && !selectedBinding) {
        const missing = document.createElement('option');
        missing.value = '';
        missing.textContent = 'No candidates — Browse workflow';
        select.append(missing);
    }
    const merged = [...candidates];
    if (selectedBinding && !merged.some(candidate => comfyBindingToken(candidate) === comfyBindingToken(selectedBinding))) merged.unshift(selectedBinding);
    for (const binding of merged) {
        const option = document.createElement('option');
        option.value = comfyBindingToken(binding);
        option.textContent = formatComfyBindingLabel(binding, comfyWorkflow);
        option.title = formatComfyBindingHelp(binding);
        select.append(option);
    }
    const selectedToken = comfyBindingToken(selectedBinding);
    if (selectedToken && Array.from(select.options).some(option => option.value === selectedToken)) select.value = selectedToken;
    else select.value = '';
    updateComfyBindingHelp(key);
}

function selectComfyBrowseCandidate(key, binding) {
    const candidate = normalizeComfyBinding(binding);
    if (!candidate) return;
    comfyCandidates = mergeComfyCandidates({ [key]: [candidate] }, comfyCandidates);
    populateComfyBindingSelect(key, candidate);
    updateComfyValidation();
}

function openComfyBindingBrowser(key) {
    if (!comfyWorkflow) return notify('error', 'Load an API workflow before browsing bindings.');
    const candidates = enumerateComfyWorkflowCandidates(comfyWorkflow, key);
    const root = document.createElement('section');
    root.className = 'image-schema-comfy-browser';
    root.dataset.swipeIgnore = 'true';
    const heading = document.createElement('h3');
    heading.textContent = `Browse ${key === 'outputNode' ? 'output' : key} bindings`;
    const search = document.createElement('input');
    search.className = 'text_pole image-schema-comfy-browser-search';
    search.type = 'search';
    search.placeholder = 'Search node, class, title, input, or current value';
    search.setAttribute('aria-label', 'Search compatible workflow inputs');
    const list = document.createElement('div');
    list.className = 'image-schema-comfy-browser-list';
    root.append(heading, search, list);
    let popup;
    const render = () => {
        const query = search.value.trim().toLocaleLowerCase();
        list.replaceChildren();
        const matches = candidates.filter(binding => [
            binding.node,
            binding.input,
            binding.classType,
            binding.title,
            binding.scalar,
            formatComfyBindingLabel(binding, comfyWorkflow),
        ].some(part => String(part || '').toLocaleLowerCase().includes(query)));
        if (!matches.length) {
            const empty = document.createElement('div');
            empty.className = 'image-schema-comfy-browser-empty';
            empty.textContent = 'No compatible inputs match this search.';
            list.append(empty);
            return;
        }
        for (const binding of matches) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'menu_button image-schema-comfy-browser-option';
            const label = document.createElement('span');
            label.textContent = formatComfyBindingLabel(binding, comfyWorkflow);
            const scalar = document.createElement('small');
            scalar.textContent = binding.scalar ? `Current: ${binding.scalar}` : formatComfyBindingHelp(binding);
            button.append(label, scalar);
            button.title = formatComfyBindingHelp(binding);
            button.addEventListener('click', () => {
                selectComfyBrowseCandidate(key, binding);
                if (popup) void popup.completeCancelled();
            });
            list.append(button);
        }
    };
    search.addEventListener('input', render);
    render();
    if (context?.Popup && context?.POPUP_TYPE) {
        popup = new context.Popup(root, context.POPUP_TYPE.DISPLAY, '', {
            okButton: 'Close',
            wide: true,
            allowVerticalScrolling: true,
            allowHorizontalScrolling: false,
            leftAlign: true,
        });
        popup.dlg.classList.add('image-schema-comfy-browser-dialog');
        void popup.show().then(() => undefined);
        queueMicrotask(() => search.focus());
    } else {
        notify('error', 'Binding browser is unavailable in this SillyTavern version.');
    }
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
        const currentBindings = comfyBindingsFromForm();
        comfyCandidates = mergeComfyCandidates(normalizeComfyCandidates(analysis), inferComfyWorkflowCandidates(comfyWorkflow));
        for (const key of COMFY_BINDING_KEYS) populateComfyBindingSelect(key, currentBindings[key]);
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
        instructionPrompt: value('image_schema_provider_instruction'),
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
            preview.textContent = resolved ? `Effective endpoint: ${resolved}${type === 'comfyui' && new URL(resolved).protocol === 'https:' ? ' · ComfyUI must actually be configured for TLS; the default listener uses http://' : ''}` : '';
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
    setValue('image_schema_provider_instruction', profile.instructionPrompt);
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
        populateRoutingControls();
        refreshInstructionPreview();
        setProviderResult(`${providerConfig.profiles.length} provider profile(s) loaded.`);
        return providerConfig;
    } catch (error) {
        setProviderResult(`Provider profiles unavailable: ${error.message}`);
        throw error;
    }
}

function populateRoutingControls() {
    const selector = document.getElementById('image_schema_fallback_profile');
    if (selector instanceof HTMLSelectElement) {
        selector.replaceChildren(new Option('Choose a profile', ''));
        for (const profile of providerConfig.profiles) selector.append(new Option(profile.name, profile.name));
        selector.value = providerConfig.routing?.fallbackProfile || '';
    }
    setChecked('image_schema_fallback_enabled', providerConfig.routing?.enabled === true);
    const selectedCodes = new Set(providerConfig.routing?.fallbackOn || []);
    document.querySelectorAll('#image_schema_fallback_conditions input[type="checkbox"]').forEach(input => {
        input.checked = selectedCodes.has(input.value);
    });
}

async function saveRouting() {
    try {
        const fallbackOn = Array.from(document.querySelectorAll('#image_schema_fallback_conditions input[type="checkbox"]:checked')).map(input => input.value);
        const body = {
            enabled: checked('image_schema_fallback_enabled'),
            fallbackProfile: value('image_schema_fallback_profile') || null,
            fallbackOn,
        };
        await pluginFetch(ROUTES.providerRouting, { method: 'POST', body: JSON.stringify(body) });
        notify('success', 'Fallback routing saved.');
        await refreshProviders(providerOriginalName);
    } catch (error) {
        notify('error', error.message);
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
    if (output) output.textContent = currentInstruction();
    document.querySelectorAll('[data-image-schema-panel]').forEach(panel => {
        panel.classList.toggle('displayNone', panel.getAttribute('data-image-schema-panel') !== settings.schema);
    });
}

function readSettingsForm() {
    settings.enabled = checked('image_schema_enabled');
    settings.showInlineControls = checked('image_schema_show_inline_controls');
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
        settings.parameterPolicies[key] = value(`image_schema_policy_${key}`);
    }
    settings = normalizeSettings(settings);
    for (const key of PARAM_ORDER) {
        document.getElementById(`image_schema_default_${key}`)?.toggleAttribute('disabled', settings.parameterPolicies[key] === 'ignore');
    }
    saveSettings();
    refreshInstructionPreview();
    queueRenderAll();
}

function populateSettingsForm() {
    setChecked('image_schema_enabled', settings.enabled);
    setChecked('image_schema_show_inline_controls', settings.showInlineControls);
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
        setValue(`image_schema_policy_${key}`, settings.parameterPolicies[key]);
        document.getElementById(`image_schema_default_${key}`)?.toggleAttribute('disabled', settings.parameterPolicies[key] === 'ignore');
    }
    refreshInstructionPreview();
}

async function copyInstruction() {
    await navigator.clipboard.writeText(currentInstruction());
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

function renderErrorStatus(result) {
    const events = Array.isArray(result?.events) ? result.events : [];
    const errors = events.filter(event => event.level === 'error');
    const latest = errors.at(-1) ?? null;
    setText('image_schema_error_count', `${errors.length} error${errors.length === 1 ? '' : 's'}`);
    setText('image_schema_error_latest', latest ? `${latest.event}${latest.profile ? ` · ${latest.profile}` : ''}${latest.code ? ` · ${latest.code}` : ''}` : 'No recent sanitized errors.');
    const badge = document.getElementById('image_schema_status_badge');
    if (badge) {
        badge.dataset.state = errors.length ? 'error' : 'ok';
        badge.textContent = errors.length ? `${errors.length} error${errors.length === 1 ? '' : 's'}` : 'OK';
    }
    document.getElementById('image_schema_copy_error')?.toggleAttribute('disabled', !latest);
    document.getElementById('image_schema_clear_errors')?.toggleAttribute('disabled', !errors.length);
    if (errors.length) document.getElementById('image_schema_status_section')?.setAttribute('open', '');
    document.getElementById('image_schema_copy_error')?.setAttribute('data-error-text', latest ? JSON.stringify(latest, null, 2) : '');
}

async function refreshPluginDiagnostics() {
    const output = document.getElementById('image_schema_diagnostics_output');
    let result;
    try {
        result = await pluginFetch(`${ROUTES.diagnosticsRecent}?limit=100`);
    } catch (error) {
        if (output) output.textContent = `Diagnostics unavailable: ${error.message}`;
        return;
    }
    if (output) output.textContent = JSON.stringify(result, null, 2);
    try {
        renderErrorStatus(result);
    } catch (error) {
        console.error('[Image Schema] Could not render diagnostics summary', error);
        if (output) output.textContent += `\n\nDiagnostics loaded, but the summary could not render: ${error.message}`;
    }
}

async function refreshOutputStats() {
    const output = document.getElementById('image_schema_output_stats');
    try {
        const stats = await pluginFetch(ROUTES.outputsStats);
        if (output) output.textContent = JSON.stringify(stats, null, 2);
    } catch (error) {
        if (output) output.textContent = `Unavailable: ${error.message}`;
    }
}

async function clearOutputs() {
    if (!window.confirm('Permanently delete durable generated outputs for this user? Existing chats may lose images.')) return;
    if (!window.confirm('This cannot be undone. Delete durable outputs?')) return;
    try {
        await pluginFetch(ROUTES.outputsClear, { method: 'POST', body: '{}' });
        await refreshOutputStats();
        notify('success', 'Durable outputs deleted.');
    } catch (error) { notify('error', error.message); }
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
    document.getElementById('image_schema_refresh_outputs')?.addEventListener('click', refreshOutputStats);
    document.getElementById('image_schema_clear_outputs')?.addEventListener('click', clearOutputs);
    document.getElementById('image_schema_copy_error')?.addEventListener('click', async event => {
        const text = event.currentTarget.dataset.errorText;
        if (text) await navigator.clipboard.writeText(text);
    });
    document.getElementById('image_schema_clear_errors')?.addEventListener('click', clearPluginDiagnostics);
    document.getElementById('image_schema_diagnostics_refresh')?.addEventListener('click', refreshPluginDiagnostics);
    document.getElementById('image_schema_diagnostics_clear')?.addEventListener('click', clearPluginDiagnostics);
    document.getElementById('image_schema_provider_profile')?.addEventListener('change', selectProvider);
    document.getElementById('image_schema_provider_refresh')?.addEventListener('click', () => refreshProviders(providerOriginalName).catch(error => notify('error', error.message)));
    document.getElementById('image_schema_save_routing')?.addEventListener('click', saveRouting);
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
    for (const key of COMFY_BINDING_KEYS) {
        document.getElementById(COMFY_BINDING_CONTROLS[key])?.addEventListener('change', () => {
            updateComfyBindingHelp(key);
            updateComfyValidation();
        });
        document.getElementById(COMFY_BINDING_BROWSE_CONTROLS[key])?.addEventListener('click', () => openComfyBindingBrowser(key));
    }
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
    registerGlobalSchemaMacro();
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
    refreshOutputStats();
    refreshPluginDiagnostics();
}

export async function clean() {
    imageLoadEpoch++;
    disarmPrompt();
    observer?.disconnect();
    observer = undefined;
    for (const [event, handler] of boundEvents.splice(0)) {
        context?.eventSource?.removeListener?.(event, handler);
    }
    context?.macros?.registry?.unregisterMacro?.(GLOBAL_SCHEMA_MACRO);
    document.getElementById('image_schema_settings')?.remove();
    if (context?.chat) {
        for (const message of context.chat) clearLegacyProjectionMetadata(message);
    }
    document.querySelectorAll('.image-schema-image').forEach(disposeImageResource);
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
