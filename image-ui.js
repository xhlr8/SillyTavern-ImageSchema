export const MAX_IMAGE_SEED = 2147483647;

/**
 * Return a copy of a normalized image request with a newly generated seed.
 * The input object is not mutated. Supplying the random function makes this
 * helper deterministic in tests.
 *
 * @param {{text: string, params?: Record<string, unknown>}} request
 * @param {() => number} [random]
 */
export function withFreshSeed(request, random = Math.random) {
    const sampled = Number(random());
    const unit = Number.isFinite(sampled) ? Math.min(Math.max(sampled, 0), 1) : 0;
    const seed = Math.min(MAX_IMAGE_SEED, Math.floor(unit * (MAX_IMAGE_SEED + 1)));
    return {
        ...request,
        params: {
            ...(request?.params || {}),
            seed,
        },
    };
}

/**
 * Parse a request stored on an image data attribute without allowing malformed
 * or unrelated DOM data to flow into regeneration controls.
 *
 * @param {unknown} serialized
 * @returns {{text: string, params: Record<string, unknown>} | null}
 */
export function parseStoredImageRequest(serialized) {
    if (typeof serialized !== 'string' || !serialized) return null;
    try {
        const request = JSON.parse(serialized);
        if (!request || typeof request !== 'object' || Array.isArray(request)) return null;
        if (typeof request.text !== 'string') return null;
        if (!request.params || typeof request.params !== 'object' || Array.isArray(request.params)) return null;
        return request;
    } catch {
        return null;
    }
}

/**
 * Add a cache-busting query parameter while preserving an existing query.
 *
 * @param {string} url
 * @param {string|number} token
 */
export function withRefreshToken(url, token = Date.now()) {
    const separator = String(url).includes('?') ? '&' : '?';
    return `${url}${separator}_refresh=${encodeURIComponent(String(token))}`;
}

/** @param {unknown} request */
export function formatEffectiveRequest(request) {
    return JSON.stringify(request, null, 2);
}
