import type { KalkiTable } from "@kalki/contracts";
import { Rows3 } from "lucide-react";
import { EmptyState, StatusPill } from "../components/common.js";
import { isObject, shortHash } from "../lib/format.js";

export function SchemaView({ tables }: { tables: KalkiTable[] }) {
  if (!tables.length) {
    return (
      <EmptyState icon={<Rows3 size={21} />} title="No registered schemas" />
    );
  }

  return (
    <div className="view-stack">
      <section className="view-heading">
        <div>
          <p className="eyebrow">Registered output</p>
          <h2>Schemas</h2>
        </div>
        <StatusPill value={`${tables.length} tables`} />
      </section>
      <div className="definition-list">
        {tables.map((table) => {
          const columns = Array.isArray(table.schema.columns)
            ? table.schema.columns
            : [];
          return (
            <section className="definition" key={table.id}>
              <header>
                <div>
                  <span className="definition__kind">{table.kind}</span>
                  <h3>{table.name}</h3>
                </div>
                <span className="mono">{shortHash(table.schema_hash)}</span>
              </header>
              <p className="definition__path">{table.schema_path}</p>
              <div className="schema-columns">
                {columns.map((column, index) => {
                  if (!isObject(column)) return null;
                  return (
                    <div className="schema-column" key={`${table.id}-${index}`}>
                      <strong>
                        {typeof column.name === "string"
                          ? column.name
                          : `column_${index + 1}`}
                      </strong>
                      <span>
                        {typeof column.type === "string"
                          ? column.type
                          : "unknown"}
                      </span>
                      <p>
                        {typeof column.description === "string"
                          ? column.description
                          : ""}
                      </p>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
