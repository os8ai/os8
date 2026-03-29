# Contributing to OS8

Thank you for your interest in contributing to OS8! This guide will help you get started.

## Getting Started

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/os8.git
   cd os8
   ```
3. Install dependencies:
   ```bash
   npm install
   npx electron-rebuild -f -w better-sqlite3
   ```
4. Run the app:
   ```bash
   npm start
   ```

**Tip:** Set `OS8_HOME` to use an isolated data directory for development:
```bash
OS8_HOME=~/os8-dev npm start
```

## Project Layout

Before diving in, review these docs:

- **[CLAUDE.md](CLAUDE.md)** — File locations, service index, API routes
- **[OS8-project-design-principles.md](OS8-project-design-principles.md)** — Code patterns, naming conventions, anti-patterns
- **[OS8 Project Context.md](OS8%20Project%20Context.md)** — Architecture and philosophy

## Making Changes

### Branch Naming

Use descriptive branch names:
- `fix/preview-zoom-offset`
- `feature/linux-support`
- `docs/contributing-guide`

### Code Style

- **Services** use static methods with `db` as the first parameter
- **IPC handlers** receive `{ db, services, state, helpers }` — no globals
- **Routes** are factory functions that receive dependencies
- **State** is managed through getters/setters in `src/renderer/state.js` — never mutate directly
- **CSS** uses custom properties (`:root` variables) — no Tailwind in the shell (Tailwind is for user apps only)
- **Naming:** files are `kebab-case`, services are `PascalCase`, IPC channels are `domain:action`
- **Exports:** single class = bare export (`module.exports = ClassName`), multiple exports = object

### Things to Avoid

- Don't add `package.json` to user apps — they use Core's shared dependencies
- Don't import `db` globally — always pass it as a parameter
- Don't put repetitive HTML in `index.html` — generate dynamic content with JavaScript
- Don't use Tailwind in the OS8 shell — shell uses vanilla CSS with variables

### Testing

```bash
npm test
```

Tests use [Vitest](https://vitest.dev/) and live in `tests/`. When adding new services or modifying existing ones, include tests.

## Pull Requests

1. Create a branch from `main`
2. Make your changes with clear, focused commits
3. Run `npm test` and make sure everything passes
4. Push to your fork and open a PR against `os8ai/os8:main`

### PR Guidelines

- Keep PRs focused — one feature or fix per PR
- Write a clear description of what changed and why
- Include before/after screenshots for UI changes
- Reference any related issues (e.g., "Fixes #42")

## Reporting Bugs

Open an [issue](https://github.com/os8ai/os8/issues) with:

- What you expected to happen
- What actually happened
- Steps to reproduce
- OS8 version and operating system

## Feature Requests

Open an [issue](https://github.com/os8ai/os8/issues) with the `enhancement` label. Describe the use case and why it would be valuable.

## Questions?

Open a [discussion](https://github.com/os8ai/os8/discussions) or reach out at leo@os8.ai.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
