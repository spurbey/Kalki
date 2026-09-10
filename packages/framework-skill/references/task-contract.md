# Task Contract & Living Memory

`task.md` is the agent's persistent state machine and working blackboard across turns. It has two layers:

## 1. Canonical Task Contract (Top Section)

Authored during alignment and reviewed by the user. Kept concise and structured:
- Objective
- Inputs and date range
- Source expectations
- Requested tables and output
- Acceptance checks
- Explicit non-goals

The canonical contract hash (`task_hash`) is computed strictly on this canonical section (everything above `---` or before `## Living Memory` / `## Exploration Findings`). Normalizes one UTF-8 BOM away and converts CRLF or CR to LF before computing SHA-256.

Register the authored task from its workspace:

```bash
PYTHONPATH="$PWD/.kalki/deps:/opt/tf/mcp-client" python -m kalki_runtime.task_cli register
```

## 2. Living Memory & Blackboard (Evolving Section)

Appended and updated by the agent incrementally below `---` or `## Living Memory`:
- `### Exploration Findings`: Observed source architecture (SSR, SPA props, JSON-LD), representative entity URLs, exact data paths/selectors, verified schema fields, and seed discovery strategy. Updated immediately upon inspecting each source.
- `### Implementation`: 
  - `#### Schema`: Markdown table detailing `| Field Name | Type | Required | Notes |`. Updated immediately upon registering the schema.
  - `#### Operators`: Inventory of source and processor operators, output keys, and seed URLs.
  - `#### Verification`: Verified sample row envelopes and test status.
- `### Progress State`: Active milestone checklist.

Updating living memory preserves the canonical `task_hash`, allowing the agent to continuously maintain state across turns without invalidating user reviews or failing production gates.

Never place secrets, credentials, or raw multi-megabyte page dumps in `task.md`. Keep raw captures under `research/captures/`.

## 3. Canonical Format Template

```markdown
# Task: <Title>

## Objective
<Single-sentence description of the target data collection>

## Inputs and Date Range
- Scope: <Scope details>
- Date range: <Date range or 'all-time'>

## Source Expectations
- Source: <Authoritative domain or URL>

## Requested Tables and Output
- <table_slug>: <Description of entity rows>

## Acceptance Checks
- Row count target: <Target count>
- Required fields populated: <Field list>

## Non-Goals
- <What is explicitly excluded>

---

## Living Memory

### Exploration Findings

#### <Source Name>
- **URL**: <Target URL>
- **Page type**: <SSR / SPA props / JSON-LD / Static HTML>
- **Navigation / Filter**: <Filter method or selector>
- **Card / List selector**: <CSS selector or JSON array path>
- **Total records / pagination**: <Count, pagination method>
- **Entity detail structure**:
  - URL format: <Path template>
  - Data paths / attributes: <e.g. #app[data-page] or CSS selectors>
  - Verified fields: <Field list confirmed on physical entity>

### Implementation

#### Schema: `schemas/<table-slug>.yaml`

| Field Name | Type | Required | Notes |
|---|---|---|---|
| <field_name> | <type> | Yes/No | <Description or PK> |

#### Operators
1. **Source**: `operators/<table_slug>.py` - Description of data extraction

#### Verification
- Test run ID: <run-id>
- Verified sample: <Compact JSON sample>
```

