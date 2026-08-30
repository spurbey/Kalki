# Schema Format

Store one YAML file per table under `schemas/<table-slug>.yaml`.

Required shape:

```yaml
version: 1
table:
  slug: example-table
  name: Example Table
  kind: source
  description: What one row represents.
  primary_key: [id]
columns:
  - name: id
    type: string
    nullable: false
    description: Stable source identifier.
```

Supported types are `string`, `integer`, `number`, `boolean`, `date`, `datetime`, `url`, and `enum`. Column names are snake case. Primary-key columns must exist and cannot be nullable. Unknown keys are invalid.

Hash the parsed object as compact JSON with recursively sorted object keys and preserved array order. Aggregate hash input is the path-sorted array of `{path, sha256}` objects.
