# SillyTavern Image Schema

Private SillyTavern UI extension for model-authored image requests. It teaches a compact image schema, renders generated images in chat, manages provider profiles, and provides zoom/copy/inspect/regenerate controls.

**Requires the private companion server plugin:** [SillyTavern-ImageSchema-Server](https://github.com/xhlr8/SillyTavern-ImageSchema-Server)

## Install / update

Install this repository from SillyTavern's **Extensions → Install extension** field:

```text
https://github.com/xhlr8/SillyTavern-ImageSchema
```

Because the repository is private, the SillyTavern host must have GitHub credentials that can clone it. Pull/update it through SillyTavern normally after authentication is configured.

Manual per-user location:

```text
SillyTavern/data/<user>/extensions/SillyTavern-ImageSchema/
```

`manifest.json` is at the repository root, so SillyTavern can discover it directly.

## Model-facing schemas

Inline (default):

```html
<img src="/image/a%20silver-haired%20traveler?ar=3%3A4&seed=42">
```

Delimiter:

```text
<image>a silver-haired traveler</image>
```

JSON:

```text
<image>{"text":"a silver-haired traveler","params":{"seed":42}}</image>
```

The extension rewrites virtual `/image/` sources to the authenticated server plugin route. Provider URLs and credentials are never included in model instructions.

## Highlights

- OpenAI-compatible, Gemini/Nano Banana, generic HTTP, and ComfyUI workflow profiles.
- ComfyUI API-workflow upload with semantic prompt/seed/output binding suggestions.
- Per-profile instruction templates. `{{schemaprompt}}` places the global schema instruction inside a profile template.
- Prompt Manager macro `{{globalschemaprompt}}` expands to **Global Schema & Prompt** only.
- Persistent settings, parser diagnostics, plugin activity, and cache/output controls.
- Responsive image popup with prompt, effective request, Copy, Inspect, and fresh-seed regeneration.
- **Show inline image controls** can omit all under-image action DOM while retaining click-to-zoom.

If `{{globalschemaprompt}}` is used in Prompt Manager, disable automatic schema injection to avoid duplication. Other SillyTavern macros in profile templates remain available to SillyTavern's normal macro pass.

## Development

```bash
npm test
npm run check
```

The extension stores no provider credentials. API keys and workflow execution are handled by the companion server plugin.
