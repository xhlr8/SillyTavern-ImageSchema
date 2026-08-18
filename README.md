# Image Schema SillyTavern extension

This directory is the browser half of the image-server implementation. It injects a model-facing image instruction, parses schemas in assistant messages, and rewrites them to the authenticated same-origin server plugin.

It does not call image providers directly, contain API credentials, or make `/image/` into a real server route. Install the companion [`../plugin/`](../plugin/) for generation.

## Installation

Copy this directory's contents into a dedicated SillyTavern third-party extension directory, for example:

```text
SillyTavern/public/scripts/extensions/third-party/image-schema/
```

The installed layout should include:

```text
image-schema/
  manifest.json
  index.js
  parser.js
  provider.js
  settings.html
  style.css
```

Restart/reload SillyTavern as required by your version and verify that **Image Schema** appears in extension settings. Install and enable the server plugin separately; see [`../plugin/README.md`](../plugin/README.md).

## How it works

For each supported generation, the extension temporarily sets an extension prompt containing the selected schema and removes it again as generation advances or ends. It does not permanently append the generated instruction to chat messages.

When an assistant message renders, the extension:

1. Parses only the active schema mode.
2. Validates prompt length, parameter names/types, aliases, and allowed model overrides.
3. Projects delimiter/JSON blocks into virtual `<img>` tags when necessary.
4. Rewrites virtual image sources such as `/image/cat?...` to `/api/plugins/image-schema/image/cat?...`.
5. Adds copy, inspect, fresh-seed regeneration, and cache guidance controls.

User and system messages are not processed. The extension also rerenders on edited/swiped messages and chat loads. Incomplete delimited/JSON output is not submitted while streaming.

The model-facing instruction contains the virtual syntax only. It does not include `/api/plugins/image-schema`, provider URLs, or secrets. This avoids exposing implementation details in the prompt, but it is not route authorization; access control remains SillyTavern's responsibility.

## Schema modes

### Inline `<img>`

Default:

```html
<img src="/image/a%20silver-haired%20traveler?ar=3%3A4&seed=42">
```

- `/image/` is configurable model syntax only.
- Encode the prompt with `encodeURIComponent` semantics.
- Use standard query strings with a **literal `&`** between parameters. Do not instruct the model to emit `&amp;`. The parser tolerates `&amp;` when a DOM/HTML serializer has already escaped the text.
- Other, nonvirtual image URLs are left unchanged.

### Delimited prompt

Default:

```text
<image>a silver-haired traveler at sunset</image>
```

Opening and closing delimiters are configurable. The body is prompt text only. The model cannot provide parameters in this mode; extension defaults and server profile defaults apply.

### JSON wrapper

Default:

```text
<image>{"text":"a silver-haired traveler","params":{"seed":42}}</image>
```

Wrapper strings plus the `text` and `params` property names are configurable. The JSON must be strict, its root must be an object, both properties must be present, and `params` must be an object (an empty object is valid).

All three modes support multiple complete occurrences. By default, matching text in Markdown inline code, triple-backtick fences, or triple-tilde fences is ignored.

## Settings reference

### General

- **Render model image schemas**: enables parsing/rewriting. Turning it off rerenders messages normally and prevents instruction injection.
- **Check plugin**: calls the same-origin profiles endpoint and displays connection status.
- **Model-facing schema**: selects inline, delimiter, or JSON parsing and instruction text.
- **Virtual base path**: inline-only model prefix. It is normalized with leading/trailing `/` and is not a server route.
- **Opening/closing delimiter or wrapper; property names**: customizes delimiter and JSON modes.
- **Ignore schemas inside Markdown code spans/fences**: enabled by default.
- **Unknown model parameter policy**: either display a parse error or ignore unknown parameters.

### Provider profiles

Provider profiles are managed by the companion same-origin plugin. The compact UI can add, duplicate, delete, save, select, set a default, and test OpenAI, Gemini SSE, and generic HTTP profiles. It edits endpoint URL, generic method, model, timeout, and the write-only API key; model allowlists and raw defaults JSON live under **Provider advanced**. ComfyUI workflow support is planned but no adapter is implemented yet.

For OpenAI-compatible providers, the URL field accepts either an API base URL or a complete generations endpoint. A base such as `https://host/openai-image` automatically resolves to `https://host/openai-image/v1/images/generations`; URLs already ending in `/v1/images/generations` are preserved. The effective endpoint is previewed before saving.

API key values are write-only: the plugin config response should expose only an `apiKeyConfigured` boolean. Replacement and clearing use the secret route directly. Keys are never copied during duplication and are never placed in `extensionSettings`.

### Defaults and allowed overrides

A default is trusted user configuration applied to every parsed request when present. **Allow** controls whether the model may replace/provide that parameter in inline or JSON mode. A model value that is recognized but not allowed becomes a visible parse error.

Default allowed overrides are seed, aspect ratio, image size, output format, and negative prompt. Backend/profile, model, temperature, person generation, width, and height are denied by default. Review these settings rather than assuming model output is trusted.

Supported names:

| UI field | Schema name | Short alias | Forwarded today |
|---|---|---|---|
| Backend/profile | `backend` | `b` | Yes, as plugin `profile` |
| Model | `model` | — | Yes; server profile must allow it |
| Seed | `seed` | — | Yes |
| Aspect ratio | `aspect_ratio` | `ar` | Yes, as `aspectRatio` |
| Image size | `image_size` | `s` | Yes, as `imageSize` |
| Output format | `output_format` | `f` | Yes |
| Temperature | `temperature` | `t` | Yes |
| Person generation | `person_generation` | `p` | Yes, as `personGeneration` |
| Width | `width` | `w` | Yes |
| Height | `height` | `h` | Yes |
| Negative prompt | `negative` | `neg` | Yes |

The extension forwards every recognized normalized field. The plugin validates all of them and includes them in request/cache normalization, while provider adapters consume different subsets. Gemini uses aspect ratio, image size, temperature, and person generation; OpenAI derives size from dimensions; generic providers receive only placeholders configured in their profile.

`seed`, width, and height must be integers (extension seed is non-negative; dimensions are positive). Temperature must be from 0 to 2. Image size is normalized to uppercase and output format to a MIME-like `image/...` value. Duplicate aliases with conflicting values are rejected.

There is deliberately no `id` parameter. Use seed as the only image identity/randomness input. A repeated request—including a seedless one—can resolve to persistent plugin cache output. See the plugin caching documentation for provider-level limitations.

### Generation instruction

- **Inject instruction ephemerally for normal generations**: enabled by default.
- **Also inject into quiet/automatic generations**: disabled by default. Dry runs are never injected.
- **Use custom instruction**: if enabled and nonblank, replaces the generated instruction exactly.
- **Live instruction preview / Copy instruction**: shows or copies the effective text.

A custom instruction is not validated against the parser settings. If it teaches a different wrapper, path, properties, or parameter policy, generated schemas may remain plain text or show errors.

### Parser, generation, and cache tools

- **Parse sample** runs the browser parser only. It does not call the plugin.
- **Test generation** calls `POST /api/plugins/image-schema/test`, bypasses cache reads, and returns metadata rather than image bytes. A successful result is still written to cache by the current server implementation.
- **Refresh cache stats** shows server-reported disk statistics and in-flight count.
- **Clear all cache** clears the authenticated user's configured plugin cache by default.

## Image controls

Each rewritten image receives:

- **Copy**: copies the image prompt, not the full parameter object.
- **Inspect**: displays the normalized extension request.
- **Dice/regenerate**: assigns a random non-negative integer seed and changes the URL. This creates a new cache key; it does not remove the previous image.

The current UI has no per-image delete button. Use bulk clearing in settings. The plugin has request-specific delete/regenerate endpoints, but the extension does not currently call them.

## Routes used internally

These are implementation details and are intentionally excluded from generated model instructions:

```text
GET  /api/plugins/image-schema/status
POST /api/plugins/image-schema/test
GET  /api/plugins/image-schema/image/:prompt
POST /api/plugins/image-schema/cache/stats
POST /api/plugins/image-schema/cache/clear
GET  /api/plugins/image-schema/providers/config
POST /api/plugins/image-schema/providers/profile/save
POST /api/plugins/image-schema/providers/profile/delete
POST /api/plugins/image-schema/providers/default
POST /api/plugins/image-schema/providers/secret
POST /api/plugins/image-schema/providers/profile/test
```

Requests use same-origin credentials and SillyTavern's request headers. Image URLs forward all recognized normalized parameters with the plugin's camel-case contract where needed.

Provider route payload contract used by the extension:

- Config response: `{ profiles: Profile[] | Record<string, Profile>, defaultProfile }`; each profile may report `apiKeyConfigured` but must not return the key.
- Save: `{ profile, previousName? }`, where `profile` contains `name`, `type`, `url`, `model`, `allowedModels`, `timeoutMs`, `defaults`, and `method` for generic HTTP. Profile types are `openai`, `gemini-sse`, and `generic`.
- Delete/default: `{ name }`.
- Secret replace: `{ name, apiKey }`; secret clear: `{ name, clear: true }`.
- Test: `{ profile }`, using the currently edited non-secret fields and the server-stored secret for that profile.

## Tests

Node.js 20+ is recommended to match the plugin runtime.

```bash
cd extension
npm test
npm run check
```

`npm test` runs both parser suites. Coverage includes inline Unicode/query parsing, literal and HTML-serialized ampersands, multiple images, malformed encoding, alias conflicts, override policy, delimiter/JSON rules, incomplete streaming output, code fences, projection, hidden plugin routes, and rejection of `id`.

These are unit tests. They do not load a SillyTavern DOM or make a live plugin/provider request.

## Troubleshooting and limitations

- **No settings panel:** verify `manifest.json` is directly in the third-party extension directory and check browser console errors.
- **Plugin unavailable:** enable/install the server plugin, set `enableServerPlugins: true` in SillyTavern's main config, install plugin dependencies, and restart SillyTavern.
- **Schema is not rendered:** select the matching mode, close the wrapper, use the configured virtual path/property names, and keep it outside code fences. SillyTavern's power-user **Encode HTML tags** option must be off because image projection uses sanitized `<img>` markup.
- **Inline parameters are truncated:** model output must use literal `&`, not a second `?`; prompts and values must be URL encoded where needed.
- **Visible parse error:** inspect unknown/disallowed parameters, malformed URL encoding, strict JSON requirements, duplicate aliases, and numeric ranges.
- **A setting has no provider effect:** all recognized fields cross the extension/plugin bridge, but provider adapters consume different subsets. Check the selected profile type and template.
- **Same image reappears:** persistent caching intentionally reuses the first successful canonical request. Regenerate with a new seed or clear the cache.
- **Cleared image still appears:** the browser may retain an already loaded immutable response. A changed request/fresh seed provides a new URL.
- **Fresh seed is not deterministic upstream:** OpenAI and Gemini adapters currently do not send the seed to their provider APIs. Seed still changes the plugin cache identity.
- **Security:** the extension does not expose API keys, but it renders model-selected prompts and allowed options into requests. Keep sensitive overrides disabled and protect the SillyTavern account/server.
