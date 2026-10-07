import { beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeRules } from '../domain/ruleAnalysis';
import type { RuleProject, WorkspaceDocument } from '../models/ruleModel';
import type { CheckOperation } from '../services/ruleCheckService';
import { RuleWorkspaceViewModel } from '../viewmodels/workspaceViewModel';

class MemoryRepository {
  document: WorkspaceDocument | null = null;
  async load() { return this.document ? structuredClone(this.document) : null; }
  async save(document: WorkspaceDocument) { this.document = structuredClone(document); }
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

  it('saves versions, freezes and resumes a version, and derives an editable copy', async () => {
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
    workspace.deriveVersionCopy(savedVersion?.id ?? '');
    expect(workspace.getSnapshot().workspace?.projects).toHaveLength(2);
    expect(workspace.getSnapshot().project?.fields).toHaveLength(3);
    workspace.dispose();
  });

  it('derives a copy that records provenance and keeps it through edits, versions and reloads', async () => {
    const repository = new MemoryRepository();
    const workspace = new RuleWorkspaceViewModel(repository, new FakeChecker());
    await workspace.start();
    const source = workspace.getSnapshot().project as RuleProject;
    workspace.freezeCurrent();
    const frozenVersion = workspace.getSnapshot().project?.versions[0];
    expect(frozenVersion?.frozen).toBe(true);

    workspace.deriveVersionCopy(frozenVersion?.id ?? '');
    const derived = workspace.getSnapshot().project as RuleProject;
    expect(derived.id).not.toBe(source.id);
    expect(derived.derivedFrom).toMatchObject({
      projectId: source.id,
      projectTitle: source.title,
      versionId: frozenVersion?.id,
      versionName: frozenVersion?.name,
    });
    expect(derived.derivedFrom?.snapshot.fields).toEqual(frozenVersion?.fields);
    expect(derived.derivedFrom?.snapshot.rules).toEqual(frozenVersion?.rules);

    // 源项目保持冻结且内容不变
    const untouched = workspace.getSnapshot().workspace?.projects.find((project) => project.id === source.id);
    expect(untouched?.frozenVersionId).toBe(frozenVersion?.id);
    expect(untouched?.rules).toEqual(source.rules);

    // 后续编辑（即使提交的对象不带来源）不会覆盖来源信息
    workspace.commitProject({ ...derived, title: '副本微调', rules: derived.rules.slice(1), derivedFrom: undefined }, '编辑副本');
    const edited = workspace.getSnapshot().project as RuleProject;
    expect(edited.title).toBe('副本微调');
    expect(edited.derivedFrom).toEqual(derived.derivedFrom);

    // 保存版本后来源信息仍然保留
    workspace.saveVersion();
    const versioned = workspace.getSnapshot().project as RuleProject;
    expect(versioned.versions).toHaveLength(1);
    expect(versioned.derivedFrom).toEqual(derived.derivedFrom);

    // 持久化并重新载入后，来源与派生时的原始内容仍可回看
    await vi.advanceTimersByTimeAsync(250);
    await workspace.flushSave();
    const restored = new RuleWorkspaceViewModel(repository, new FakeChecker());
    await restored.start();
    const reloaded = restored.getSnapshot().workspace?.projects.find((project) => project.id === derived.id);
    expect(reloaded?.derivedFrom).toEqual(derived.derivedFrom);
    expect(reloaded?.derivedFrom?.snapshot.rules).toEqual(frozenVersion?.rules);
    restored.dispose();
    workspace.dispose();
  });
});
