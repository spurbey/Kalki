import type { WorkbookSnapshot } from "@kalki/contracts";
import {
  Activity,
  FileText,
  FlaskConical,
  Paperclip,
  Rows3,
  Table2,
} from "lucide-react";
import { ArtifactsView } from "../views/ArtifactsView.js";
import { RunsView } from "../views/RunsView.js";
import { SchemaView } from "../views/SchemaView.js";
import { TablesView } from "../views/TablesView.js";
import { TaskView } from "../views/TaskView.js";
import { TestView } from "../views/TestView.js";

export type WorkspaceView =
  "task" | "schema" | "test" | "tables" | "runs" | "artifacts";

const views: Array<{
  id: WorkspaceView;
  label: string;
  icon: typeof FileText;
}> = [
  { id: "task", label: "Task", icon: FileText },
  { id: "schema", label: "Schema", icon: Rows3 },
  { id: "test", label: "Test", icon: FlaskConical },
  { id: "tables", label: "Tables", icon: Table2 },
  { id: "runs", label: "Runs", icon: Activity },
  { id: "artifacts", label: "Artifacts", icon: Paperclip },
];

export function WorkspacePane({
  snapshot,
  activeView,
  onViewChange,
  onRefresh,
}: {
  snapshot: WorkbookSnapshot;
  activeView: WorkspaceView;
  onViewChange: (view: WorkspaceView) => void;
  onRefresh: () => Promise<void>;
}) {
  const task = snapshot.tasks[0] ?? null;
  return (
    <section className="workbook-pane">
      <nav className="workspace-tabs" aria-label="Workbook views">
        {views.map((view) => {
          const Icon = view.icon;
          return (
            <button
              key={view.id}
              type="button"
              className={
                activeView === view.id
                  ? "workspace-tab workspace-tab--active"
                  : "workspace-tab"
              }
              onClick={() => onViewChange(view.id)}
            >
              <Icon size={15} />
              {view.label}
            </button>
          );
        })}
      </nav>
      <div className="workspace-view">
        {activeView === "task" ? (
          <TaskView
            task={task}
            workbookId={snapshot.workbook.id}
            onRefresh={onRefresh}
          />
        ) : null}
        {activeView === "schema" ? (
          <SchemaView tables={snapshot.tables} />
        ) : null}
        {activeView === "test" ? <TestView runs={snapshot.runs} /> : null}
        {activeView === "tables" ? <TablesView snapshot={snapshot} /> : null}
        {activeView === "runs" ? <RunsView runs={snapshot.runs} /> : null}
        {activeView === "artifacts" ? (
          <ArtifactsView snapshot={snapshot} />
        ) : null}
      </div>
    </section>
  );
}
