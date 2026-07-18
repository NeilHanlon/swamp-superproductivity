# Build / upgrade the plugin artifact

`build_plugin` makes plugin version-drift structurally impossible: `manifest.json`
is the single source of truth for the version, which is stamped into
`plugin.js`'s `__PLUGIN_VERSION__` token **in the artifact only** (source keeps
the token), and the fixed three-file archive (`manifest.json`, `plugin.js`,
`index.html`) is produced with a pinned pure-JS zip writer.

## When to run it

- After ANY change to plugin code (`plugin/plugin.js`, `plugin/index.html`) or
  `plugin/manifest.json`. Bump `plugin/manifest.json`'s `version` first — reusing
  a version for two different contents defeats the drift guard.
- Model-only edits (`super_productivity.ts`) do NOT need a rebuild.

## Run it from the workspace root

```bash
swamp model method run sp build_plugin
```

Defaults: `pluginDir=extensions/super-productivity/plugin`,
`outZip=extensions/super-productivity/sp-swamp-plugin.zip`. The paths are
**contained to the workspace root** (`Deno.cwd()`): relative defaults resolve
inside it; a caller-supplied `..` or out-of-root absolute path is rejected before
any filesystem access. Run from the swamp workspace root so the defaults resolve.

The result reports the stamped `version`, the archive `files`, `bytes`, and the
`sha256` — the proof surface that the artifact matches the manifest.

## After building

1. Re-import `plugin/sp-swamp-plugin.zip` into SP.
2. **Restart Super Productivity** so the loop loads the new build.
3. `swamp model method run sp plugin_status` — confirm the reported `version`
   matches the manifest you just stamped.

## Version-drift symptom

If `plugin_status` reports an old `version`, or returns a `forbidden_action`
meta-channel hint, the running plugin is stale: rebuild, re-import, restart.
