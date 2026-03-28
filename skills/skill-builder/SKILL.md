---
name: skill-builder
description: Create new skills for yourself or all agents. Use when you want to build a repeatable workflow, automate a recurring task, define a new capability, or package a process as a reusable skill. Also use when asked to "make a skill", "create a skill", "turn this into a skill", or "automate this".
version: 1.0.0
tags: [meta, skills, automation, workflows]
---

# Skill Builder

Create new skills — repeatable workflows that you or other agents can use, optionally tied to timed jobs for automatic execution.

## When to use this

- You want to automate something you do repeatedly
- You want to package a workflow so it runs on a schedule
- Someone asks you to "turn this into a skill" or "create a skill for X"
- You need a new capability that doesn't exist yet

## Where skills live

**Agent-scoped** (only you can use it):
```
skills/{skill-name}/SKILL.md
```
This is relative to your agent directory. Use this for personal workflows.

**System-wide** (all agents can use it):
```
~/os8/skills/{skill-name}/SKILL.md
```
Use this when the skill is useful to any agent, not just you.

Create the directory first, then write the SKILL.md file inside it.

## SKILL.md format

Every skill is a single `SKILL.md` file with optional YAML frontmatter and a markdown body.

### Frontmatter

```yaml
---
name: my-skill-name
description: What this skill does and when to use it. Be specific — this is how agents discover your skill.
version: 1.0.0
tags: [relevant, tags]
---
```

- `name` — kebab-case identifier (must match directory name)
- `description` — 1-2 sentences. Include both what it does AND when to trigger it. Be direct: "Use when..." is better than a vague summary
- `version` and `tags` are optional but helpful

If your skill calls OS8 API endpoints, also add:

```yaml
endpoints:
  - method: POST
    path: /api/telegram/send
    description: Send message via Telegram
```

### Body structure

Write the body as clear instructions to yourself (or another agent). Use this structure:

```markdown
# Skill Name

One-line purpose statement.

## Process

### 1. First step
What to do, with specifics.

### 2. Second step
Continue with clear instructions.

### 3. Deliver the output
How and where to deliver results.

### 4. Complete the job
End with the completion signal (if tied to a timed job).

## Guidelines
- Key constraints or quality standards
- What to avoid
- Tone, length, format rules
```

### Writing good skill instructions

**Be concrete, not abstract.** "Search for 3-4 news items from the last 48 hours" is better than "gather relevant information."

**Include full API URLs.** Always use `http://localhost:8888/api/...` with complete curl examples. Relative URLs fail on some backends.

```bash
curl -s -X POST http://localhost:8888/api/telegram/send \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "YOUR_AGENT_ID",
    "text": "message here"
  }'
```

**Write for yourself.** The best skills read like notes from your future self — "here's exactly what to do, step by step." Don't over-formalize.

**Keep it short.** The ai-digest skill is 105 lines and works perfectly. If your skill is over 150 lines, you're probably overcomplicating it.

**Include an example output** if the skill produces formatted text. Show what good looks like.

## Tying a skill to a timed job

If your skill should run on a schedule, create the job after writing the skill. Use the agent-jobs API:

```bash
curl -X POST http://localhost:8888/api/agent/{your-agent-id}/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Descriptive Job Name",
    "description": "What to do when this job runs — written as an instruction to yourself.",
    "skill": "my-skill-name",
    "type": "recurring",
    "schedule": {"frequency": "daily", "time": "09:00"}
  }'
```

The `skill` field loads your SKILL.md into context when the job fires. The `description` field is the prompt you receive.

### Job completion signal

When a skill runs as a timed job, you must end your response with exactly one of:

```
[JOB_COMPLETE: 2-3 sentences describing what you accomplished]
```
```
[JOB_COULD_NOT_COMPLETE: brief explanation of what went wrong]
```

Include this requirement in your skill's Process section if the skill will be job-driven.

### Common schedules

| Pattern | Schedule |
|---------|----------|
| Every morning | `{"frequency": "daily", "time": "08:00"}` |
| Weekday afternoons | `{"frequency": "weekdays", "time": "14:00"}` |
| Every Monday | `{"frequency": "weekly", "time": "09:00", "dayOfWeek": 1}` |
| Every 4 hours | `{"frequency": "every-x-hours", "interval": 4}` |
| First of month | `{"frequency": "monthly", "time": "09:00", "dayOfMonth": 1}` |

## Complete example

Here's a real working skill — an AI news digest delivered daily via Telegram:

```markdown
---
name: ai-digest
description: Daily curated intelligence on AI agents, research, and multi-agent systems. Delivered via Telegram.
version: 1.0.0
tags: [news, digest, ai, research]
---

# AI Agent Digest

Scan the web for the latest in personal AI agents and LLM research. Produce a tight, curated digest and deliver it via Telegram each morning.

## Process

### 1. Search for fresh content

Run 3-4 targeted web searches focused on the last 24-48 hours:
- "AI agent news today 2026"
- "personal AI assistant agent launch 2026"
- "LLM autonomous agent research 2026"

Look for new frameworks, significant research, industry shifts. Avoid generic takes and PR fluff.

### 2. Curate and format

Select 5-8 distinct items. Each item: 1-2 sentences max.

AI AGENTS — [Day], [Month] [Date]

1. [Headline] — [Summary of what happened and why it matters]
2. [Headline] — [Summary]
...

— [Your Name]

### 3. Deliver via Telegram

curl -s -X POST http://localhost:8888/api/telegram/send \
  -H "Content-Type: application/json" \
  -d '{"agentId": "YOUR_AGENT_ID", "text": "DIGEST TEXT"}'

### 4. Complete

[JOB_COMPLETE: AI Agent Digest delivered. X items. DATE.]

## Guidelines
- Under 400 words total
- Signal over noise — opinionated curation is the point
- Text format, not voice — this is for scanning
```

Then create the timed job:

```bash
curl -X POST http://localhost:8888/api/agent/{agentId}/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "name": "AI Agent Digest",
    "description": "Run the AI Agent Digest skill — search, curate, format, and deliver via Telegram.",
    "skill": "ai-digest",
    "type": "recurring",
    "schedule": {"frequency": "daily", "time": "10:00"}
  }'
```

## Checklist before you're done

1. Directory created (`skills/{name}/`)
2. SKILL.md written with frontmatter + body
3. Full API URLs included (not relative paths)
4. Completion signal documented (if job-driven)
5. Timed job created (if scheduled)
6. Tested once manually to confirm it works
