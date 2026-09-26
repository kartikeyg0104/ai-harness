# Extending BMAD

BMAD-METHOD stays pinned at `5e33d3c03ba53187a40ab679d5479cdd4b6ac2fb`. Skill prose is not vendored. A skill completes only when a configured runner returns the pinned headless contract and the named files exist.

## Plugins

Install a local manifest. It is not fetched from the network.

```bash
bmad-next plugin install ./plugin.json
bmad-next plugin enable tea-local
bmad-next plugin disable tea-local
bmad-next plugin remove tea-local
```

The manifest needs `id`, `version`, `source`, `license`, `tools`, and `permissions` (`read`, `write`, `execute`, `network`, `credentials`, `filesystem`). Installation does not publish a skill. Skill publication still requires an evaluation where every case passed.

## Builder and TEA

`bmad-next` builder and TEA commands write draft artifacts from mission state. They are not the upstream Builder or TEA module. `completed` stays false until that module is installed and a real run finishes. Drafts cannot open the release gate.

## Domain modules

Creative Intelligence Suite and Game Dev Studio are marketplace entries. They are not selected unless installed. Game-looking paths are reported by the repository scan and are not treated as a reconstructed architecture.
