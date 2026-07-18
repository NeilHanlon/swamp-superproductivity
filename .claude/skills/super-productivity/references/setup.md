# Setup — bring the bridge up from scratch

The bridge has two halves that must agree on an HMAC secret: the **swamp model**
(server) and the **SP plugin** (long-lived client). Setup is: vault the secret →
create the model → `provision` (writes the plugin's token copy) → import + enable
the plugin → **restart SP**.

## 1. Vault the HMAC secret + instance uuid

The real secret is `authSecret`; it is vaulted and marked sensitive. `authInstance`
is a uuid binding this model to one SP instance. Store both in a vault, then wire
them into the model via CEL global-args (never inline the literal secret).

```bash
# (example only — use your own vault + values)
swamp vault create <type> super-productivity
# store secret + instance keys in it, then reference them below.
```

## 2. Create the model

```bash
swamp model create @kneel/super-productivity sp \
  --global-arg dataDir=/path/to/super-productivity-swamp \
  --global-arg authSecret='${{ vault.get(super-productivity, secret) }}' \
  --global-arg authInstance='${{ vault.get(super-productivity, instance) }}'
```

- `dataDir` is the bridge rendezvous dir. It gets `plugin_commands/` +
  `plugin_responses/` subdirs and the plugin's `.auth_token`. Use a dir dedicated
  to THIS bridge so it never contends with another MCP/bridge plugin.

## 3. Provision the plugin's token copy

```bash
swamp model method run sp provision
```

Idempotent. Creates the bridge dirs and writes the plugin's `0600 .auth_token`
copy of `{v, secret, instance}` from the vault. Does NOT touch running SP.

## 4. Import + enable the plugin, then restart SP

1. In SP: Settings → Plugins → import `plugin/sp-swamp-plugin.zip` (the canonical
   artifact stamped by `build_plugin`; see [build.md](build.md)).
2. Enable it.
3. **Restart Super Productivity.** The plugin loop only picks up a freshly
   imported build after a restart.

## 5. Verify

```bash
swamp model method run sp plugin_status   # version, ownership, lock freshness
swamp model method run sp sync            # tasks-main / projects-main / tags-main
```

`plugin_status.isOwner:true` with a fresh (non-stale) lock means the loop is live
and holds the single-writer bridge lock. Reference the pulled data with CEL:

```
data.latest("sp", "tasks-main").attributes.tasks
```
