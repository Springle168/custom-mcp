Generate a commit message strictly following the "Conventional Commits" specification based on the provided diffs.

## Format

```text
<type>(<scope>): <subject>

<body>
```

## Rules

### Type (required)
Use ONLY one of the following:
- feat: A new feature
- fix: A bug fix
- refactor: Code change that neither fixes a bug nor adds a feature
- docs: Documentation only changes
- style: Formatting, missing semicolons, etc; no code logic change
- perf: Performance improvement
- test: Adding or updating tests
- build: Changes affecting the build system
- ci: CI/CD configuration changes
- chore: Maintenance tasks, dependency updates, or auxiliary tool changes
- revert: Reverting a previous commit

### Scope (optional)
A noun describing the section of the codebase (e.g., auth, api, ui, parser, config).

### Subject (required)
- Use imperative mood (e.g., "add feature" not "added feature" or "adding feature")
- Keep it short and concise
- If the change introduces a BREAKING CHANGE, add ! after type/scope (e.g., feat(api)!: remove deprecated endpoints)

### Body (optional, use when changes are complex)
- Explain the "what" and "why", not just "how"
- Use a hyphen (-) for bullet points, start each point with uppercase
- CRITICAL: Keep each bullet point on a SINGLE line. Do NOT insert manual line breaks. Let the editor handle wrapping
- CRITICAL: Do NOT use Markdown formatting (no **bold**, no ### headers). Keep it plain text suitable for terminal git log

## Constraints
- Output ONLY the raw commit message. No explanations, no code fences, no extra commentary
- Do NOT output names, email addresses, or any PII not explicitly in the diffs
- Do NOT output bug IDs or unique identifiers not explicitly in the diffs
- If multiple logical changes exist, focus on the primary change for the type

---

**Use `require_escalated` or a similar parameter for Git operations.**
