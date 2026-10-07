import { beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeRules } from '../domain/ruleAnalysis';
import type { RuleProject, WorkspaceDocument } from '../models/ruleModel';
import { RuleRepository } from '../repositories/ruleRepository';
import type { ProjectStorageService } from '../services/projectStorageService';
import type { CheckOperation } from '../services/ruleCheckService';
import { RuleWorkspaceViewModel } from '../viewmodels/workspaceViewModel';

class MemoryRepository {
  document: WorkspaceDocument | null = null;
  async load() { return this.document ? structuredClone(this.document) : null; }
  async save(document: WorkspaceDocument) { this.document = structuredClone(document); }
}

class StubStorage {
  constructor(private readonly value: unknown) {}
  async read() { return this.value; }
  readFallback() { return null; }
  async write() { return undefined; }
}

class FakeChecker {
  calls = 0;
  nextError: Error | null = null;
  cancelled = false;

  run(project: RuleProject): CheckOperation {
    this.calls += 1;
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      return { promise: Promise.reject(error), cancel: () => { this.cancelled = true; } };
    }
    return { promise: Promise.resolve(analyzeRules(project)), cancel: () => { this.cancelled = true; } };
  }
}

describe('RuleWorkspaceViewModel', () => {
  beforeEach(() => vi.useFakeTimers());

  it('initializes a usable demo, runs checks, persists edits, and recovers the workspace', async () => {
    const repository = new MemoryRepository();
    const checker = new FakeChecker();
    const workspace = new RuleWorkspaceViewModel(repository, checker);
    await workspace.start();
    expect(workspace.getSnapshot().project?.fields).toHaveLength(3);
    expect(workspace.getSnapshot().project?.rules).toHaveLength(4);

    await vi.advanceTimersByTimeAsync(50);
    expect(workspace.getSnapshot().checkStatus).toBe('success');
    const current = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...current, title: '已修改策略' }, '测试编辑', { recheck: false });
    await vi.advanceTimersByTimeAsync(250);
    await workspace.flushSave();
    expect(repository.document?.projects[0].title).toBe('已修改策略');

    const restored = new RuleWorkspaceViewModel(repository, checker);
    await restored.start();
    expect(restored.getSnapshot().project?.title).toBe('已修改策略');
    restored.dispose();
    workspace.dispose();
  });

  it('shows check errors and recovers on the next successful run', async () => {
    const repository = new MemoryRepository();
    const checker = new FakeChecker();
    const workspace = new RuleWorkspaceViewModel(repository, checker);
    await workspace.start();
    checker.nextError = new Error('worker unavailable');
    await workspace.runCheck();
    expect(workspace.getSnapshot().phase).toBe('error');
    expect(workspace.getSnapshot().notice).toBe('worker unavailable');
    await workspace.runCheck();
    expect(workspace.getSnapshot().checkStatus).toBe('success');
    expect(workspace.getSnapshot().analysis).not.toBeNull();
    workspace.dispose();
  });

  it('marks cancellation and blocks checks for invalid projects', async () => {
    const repository = new MemoryRepository();
    const checker = new FakeChecker();
    const workspace = new RuleWorkspaceViewModel(repository, checker);
    await workspace.start();
    const project = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...project, fields: project.fields.map((field) => field.id === 'cart-total' ? { ...field, min: 10, max: 0 } : field) });
    expect(workspace.getSnapshot().phase).toBe('validating');
    const callsBefore = checker.calls;
    await workspace.runCheck();
    expect(workspace.getSnapshot().checkStatus).toBe('error');
    expect(checker.calls).toBe(callsBefore);
    workspace.dispose();
  });

  it('saves versions, freezes and resumes a version, and derives it into a new project', async () => {
    const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), new FakeChecker());
    await workspace.start();
    workspace.saveVersion();
    const savedVersion = workspace.getSnapshot().project?.versions[0];
    expect(savedVersion?.frozen).toBe(false);

    workspace.freezeCurrent();
    const frozen = workspace.getSnapshot().project;
    expect(frozen?.frozenVersionId).toBe(frozen?.versions[0].id);
    expect(workspace.commitProject({ ...(frozen as RuleProject), title: '不允许修改' })).toBe(false);

    workspace.restoreVersion(savedVersion?.id ?? '');
    expect(workspace.getSnapshot().project?.frozenVersionId).toBeUndefined();
    workspace.deriveVersionToProject(savedVersion?.id ?? '');
    expect(workspace.getSnapshot().workspace?.projects).toHaveLength(2);
    expect(workspace.getSnapshot().project?.fields).toHaveLength(3);
    workspace.dispose();
  });

  it('derives an editable copy from a frozen version and keeps provenance across edits and saves', async () => {
    const repository = new MemoryRepository();
    const workspace = new RuleWorkspaceViewModel(repository, new FakeChecker());
    await workspace.start();
    const sourceId = workspace.getSnapshot().project?.id ?? '';
    const sourceTitle = workspace.getSnapshot().project?.title ?? '';

    workspace.freezeCurrent();
    const frozenVersion = workspace.getSnapshot().project?.versions[0];
    expect(frozenVersion?.frozen).toBe(true);

    workspace.deriveVersionToProject(frozenVersion?.id ?? '');
    const derived = workspace.getSnapshot().project as RuleProject;
    expect(derived.id).not.toBe(sourceId);
    expect(derived.frozenVersionId).toBeUndefined();
    expect(derived.derivedFrom).toMatchObject({
      projectId: sourceId,
      projectTitle: sourceTitle,
      versionId: frozenVersion?.id,
      versionName: frozenVersion?.name,
    });

    workspace.commitProject({ ...derived, title: '冻结后的小调整' }, '测试编辑', { recheck: false });
    expect(workspace.getSnapshot().project?.title).toBe('冻结后的小调整');
    expect(workspace.getSnapshot().project?.derivedFrom).toEqual(derived.derivedFrom);

    workspace.saveVersion();
    const afterSave = workspace.getSnapshot().project as RuleProject;
    expect(afterSave.versions).toHaveLength(1);
    expect(afterSave.derivedFrom).toEqual(derived.derivedFrom);

    workspace.restoreVersion(afterSave.versions[0].id);
    expect(workspace.getSnapshot().project?.derivedFrom).toEqual(derived.derivedFrom);

    const source = workspace.getProvenanceSource();
    expect(source?.project.id).toBe(sourceId);
    expect(source?.version.id).toBe(frozenVersion?.id);
    expect(source?.version.rules).toHaveLength(4);
    workspace.dispose();
  });

  it('preserves provenance through the repository round trip', async () => {
    const repository = new MemoryRepository();
    const workspace = new RuleWorkspaceViewModel(repository, new FakeChecker());
    await workspace.start();
    workspace.freezeCurrent();
    workspace.deriveVersionToProject(workspace.getSnapshot().project?.versions[0]?.id ?? '');
    const provenance = workspace.getSnapshot().project?.derivedFrom;
    await vi.advanceTimersByTimeAsync(250);
    await workspace.flushSave();

    const decoded = await new RuleRepository(new StubStorage(repository.document) as unknown as ProjectStorageService).load();
    const restored = decoded?.projects.find((project) => project.id === workspace.getSnapshot().project?.id);
    expect(restored?.derivedFrom).toEqual(provenance);
    workspace.dispose();
  });
});
