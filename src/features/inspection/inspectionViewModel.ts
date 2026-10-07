import type { RuleProject, RuleVersion } from '../../models/ruleModel';
import type { RuleWorkspaceViewModel } from '../../viewmodels/workspaceViewModel';

export class InspectionViewModel {
  constructor(private readonly workspace: RuleWorkspaceViewModel) {}

  check(): Promise<void> {
    return this.workspace.runCheck();
  }

  cancel(): void {
    this.workspace.cancelCheck();
  }

  saveVersion(): void {
    this.workspace.saveVersion();
  }

  freeze(): void {
    this.workspace.freezeCurrent();
  }

  continueFrom(versionId: string): void {
    this.workspace.restoreVersion(versionId);
  }

  deriveToProject(versionId: string): void {
    this.workspace.deriveVersionToProject(versionId);
  }

  derivedSource(): { project: RuleProject; version: RuleVersion } | null {
    return this.workspace.getProvenanceSource();
  }
}
