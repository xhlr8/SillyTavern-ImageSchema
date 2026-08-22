import { activeSwipeKey, getImagePin, readImagePins, setImagePin } from './image-ui.js';

export { activeSwipeKey, getImagePin, readImagePins, setImagePin };

export function clearImagePin(message, occurrence) {
    if (!message || !Number.isInteger(Number(occurrence))) return null;
    const key = activeSwipeKey(message);
    const pins = structuredClone(readImagePins(message));
    const entries = Array.isArray(pins[key]) ? [...pins[key]] : [];
    const removed = entries[Number(occurrence)] ?? null;
    entries[Number(occurrence)] = null;
    pins[key] = entries;
    message.extra ??= {};
    message.extra.image_schema_outputs = pins;
    if (typeof message.swipe_id === 'number' && Array.isArray(message.swipe_info) && message.swipe_info[message.swipe_id]) {
        message.swipe_info[message.swipe_id].extra ??= {};
        message.swipe_info[message.swipe_id].extra.image_schema_outputs = structuredClone(pins);
    }
    return removed;
}

export function countImagePins(messages) {
    let total = 0;
    const outputIds = new Set();
    for (const message of Array.isArray(messages) ? messages : []) {
        const pins = readImagePins(message);
        for (const entries of Object.values(pins)) {
            if (!Array.isArray(entries)) continue;
            for (const pin of entries) {
                if (!pin?.outputId) continue;
                total++;
                outputIds.add(pin.outputId);
            }
        }
    }
    return { total, uniqueOutputs: outputIds.size };
}
