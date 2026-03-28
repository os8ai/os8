# OS8 Services

This directory contains service modules that provide core business logic for OS8.

## Service Overview

This directory contains ~60 service modules. See [CLAUDE.md](../../CLAUDE.md) (Services table) for the full inventory with descriptions.

## Patterns

### Static vs Instance Methods

**Use static methods** when the service is stateless and operates on passed-in dependencies:

```javascript
// Good: Stateless service with static methods
class AppService {
  static getById(db, id) { ... }
  static create(db, name, color) { ... }
}
```

**Use instance methods** when the service maintains state or configuration:

```javascript
// Good: Stateful service with instance
class TelegramWatcher {
  constructor(options) {
    this.token = options.token;
    this.isRunning = false;
  }

  start() { ... }
  stop() { ... }
}
```

### Database Access

Services receive the database connection as a parameter, not as a global:

```javascript
// Good: db passed explicitly
static getById(db, id) {
  const stmt = db.prepare('SELECT * FROM apps WHERE id = ?');
  return stmt.get(id);
}

// Bad: accessing global db
static getById(id) {
  const stmt = globalDb.prepare(...);
}
```

### Error Handling

Services should throw errors for the caller to handle, not swallow them:

```javascript
// Good: Let caller handle errors
static create(db, name) {
  if (!name) throw new Error('Name is required');
  // ...
}

// Bad: Swallowing errors
static create(db, name) {
  try {
    if (!name) return null;  // Silent failure
  } catch (e) {
    return null;  // Lost error context
  }
}
```

Exception: File utilities like `loadJSON` may return default values on error since missing files are expected.

### Async vs Sync

**Sync for database operations** - better-sqlite3 is synchronous:

```javascript
// Good: Sync for SQLite
static getById(db, id) {
  return db.prepare('SELECT * FROM apps WHERE id = ?').get(id);
}
```

**Async for I/O and external processes**:

```javascript
// Good: Async for file I/O or external commands
async setup() {
  await this.installDependencies();
  await this.generateConfig();
}
```

### Service Dependencies

Services should not import each other directly. Pass dependencies through function parameters:

```javascript
// Good: Dependency injection
function registerHandlers({ db, services }) {
  const { AppService, TasksFileService } = services;
  // Use services...
}

// Bad: Direct imports creating tight coupling
const AppService = require('./app');
const TasksFileService = require('./tasks-file');
```

## Testing

Run tests with:

```bash
npm test
```

Tests are in `tests/services/` and follow the pattern `{service}.test.js`.

### Export Convention

**Single-class files** (the vast majority) use bare exports:

```javascript
class AgentService { /* ... */ }
module.exports = AgentService;

// Caller
const AgentService = require('./agent');
```

**Multi-export files** (class + constants, or multiple functions) use object exports:

```javascript
class WorkQueue { /* ... */ }
const PRIORITY_THREAD = 10;
module.exports = { WorkQueue, PRIORITY_THREAD };

// Caller
const { WorkQueue, PRIORITY_THREAD } = require('./work-queue');
```

Do not wrap a single class in an object. Destructuring a bare export (`const { X } = require(...)`) silently returns `undefined` — no error at require time, just a crash later.

## Adding a New Service

1. Create the service file in `src/services/`
2. Follow the static/instance pattern based on statefulness
3. Use bare export (`module.exports = ClassName`) for single-class files
4. Export from `src/services/index.js` if needed by IPC handlers
5. Add tests in `tests/services/{service}.test.js`
6. Add to the Services table in `CLAUDE.md`
