# pi-harness-extras

Personal pi package for custom extensions, skills, and prompt templates.

## Structure

- `extensions/` — TypeScript pi extensions
- `skills/` — Agent Skills / pi skills
- `prompts/` — pi prompt templates

## Local development

Point pi at this package from `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "/Users/german/code/pi-harness-extras"
  ]
}
```

Then use `/reload` inside pi after edits.

## Install from git

Once pushed, this package can also be loaded via:

```json
{
  "packages": [
    "git:github.com/german-muzquiz/pi-harness-extras"
  ]
}
```
