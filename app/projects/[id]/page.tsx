"use client";

import { useParams } from "next/navigation";
import { WorkbenchProvider } from "@/lib/workbench";
import WorkbenchShell from "@/components/WorkbenchShell";

export default function ProjectPage() {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <WorkbenchProvider projectId={projectId}>
      <WorkbenchShell />
    </WorkbenchProvider>
  );
}
