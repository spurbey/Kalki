import type { WorkbookSnapshot } from "@kalki/contracts";
import { CheckCircle2, Paperclip } from "lucide-react";
import { EmptyState, StatusPill } from "../components/common.js";
import { formatTime } from "../lib/format.js";

export function ArtifactsView({ snapshot }: { snapshot: WorkbookSnapshot }) {
  if (!snapshot.artifacts.length && !snapshot.generated_skills.length) {
    return <EmptyState icon={<Paperclip size={21} />} title="No artifacts" />;
  }

  return (
    <div className="view-stack">
      <section className="view-heading">
        <div>
          <p className="eyebrow">Run outputs</p>
          <h2>Artifacts</h2>
        </div>
        <StatusPill
          value={`${snapshot.artifacts.length} ${snapshot.artifacts.length === 1 ? "file" : "files"}`}
        />
      </section>
      <div className="artifact-list">
        {snapshot.artifacts.map((artifact) => (
          <article className="artifact-row" key={artifact.id}>
            <Paperclip size={17} />
            <div>
              <strong>{artifact.path}</strong>
              <p>
                {artifact.mime_type} -{" "}
                {Math.max(1, Math.round(artifact.size_bytes / 1024))} KB
              </p>
            </div>
            <span>{formatTime(artifact.created_at)}</span>
          </article>
        ))}
        {snapshot.generated_skills.map((skill) => (
          <article className="artifact-row" key={skill.id}>
            <CheckCircle2 size={17} />
            <div>
              <strong>{skill.name}</strong>
              <p>
                {skill.registration_status} - {skill.commit_sha.slice(0, 8)}
              </p>
            </div>
            <span>{skill.mount_smoke_status}</span>
          </article>
        ))}
      </div>
    </div>
  );
}
