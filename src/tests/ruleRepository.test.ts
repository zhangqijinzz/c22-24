import { describe, expect, it } from 'vitest';
import type { VersionProvenance, WorkspaceDocument } from '../models/ruleModel';
import { RuleRepository } from '../repositories/ruleRepository';
import type { ProjectStorageService } from '../services/projectStorageService';

class MemoryStorage implements Pick<ProjectStorageService, 'read' | 'readFallback' | 'write'> {
  serialized: string | null = null;
  async read() { return this.serialized ? JSON.parse(this.serialized) as unknown : null; }
  readFallback() { return this.serialized ? JSON.parse(this.serialized) as unknown : null; }
  async write(document: WorkspaceDocument) { this.serialized = JSON.stringify(document); }
}

const provenance: VersionProvenance = {
  projectId: 'project-source',
  projectTitle: '会员权益与折扣策略',
  versionId: 'version-frozen-1',
  versionName: '冻结版本 1',
  derivedAt: 1728000000000,
  snapshot: {
    fields: [{ id: 'amount', name: '金额', type: 'number', min: 0, max: 1000 }],
    rules: [{ id: 'rule-a', name: '大额优惠', priority: 10, result: '9 折', conditions: { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'gte', value: 500 }] } }],
    sampleInputs: { amount: 600 },
  },
};

function workspaceWith(derivedFrom: unknown): WorkspaceDocument {
  return {
    schemaVersion: 1,
    activeProjectId: 'project-copy',
    projects: [{
      id: 'project-copy',
      title: '副本项目',
      fields: [{ id: 'amount', name: '金额', type: 'number', min: 0, max: 1000 }],
      rules: [],
      sampleInputs: {},
      versions: [],
      updatedAt: 1,
      ...(derivedFrom === undefined ? {} : { derivedFrom: derivedFrom as VersionProvenance }),
    }],
  };
}

describe('RuleRepository provenance persistence', () => {
  it('keeps derivedFrom and its snapshot through a serialized round trip', async () => {
    const storage = new MemoryStorage();
    const repository = new RuleRepository(storage as unknown as ProjectStorageService);
    await repository.save(workspaceWith(provenance));
    const loaded = await repository.load();
    expect(loaded?.projects[0].derivedFrom).toEqual(provenance);
    expect(loaded?.projects[0].derivedFrom?.snapshot.rules[0].name).toBe('大额优惠');
  });

  it('drops a corrupted derivedFrom without blocking the project from loading', async () => {
    const storage = new MemoryStorage();
    const repository = new RuleRepository(storage as unknown as ProjectStorageService);
    const corrupted = { ...provenance, snapshot: { ...provenance.snapshot, rules: [{ broken: true }] } };
    await repository.save(workspaceWith(corrupted));
    const loaded = await repository.load();
    expect(loaded?.projects).toHaveLength(1);
    expect(loaded?.projects[0].derivedFrom).toBeUndefined();
  });

  it('loads projects that predate provenance tracking', async () => {
    const storage = new MemoryStorage();
    const repository = new RuleRepository(storage as unknown as ProjectStorageService);
    await repository.save(workspaceWith(undefined));
    const loaded = await repository.load();
    expect(loaded?.projects[0].derivedFrom).toBeUndefined();
  });
});
