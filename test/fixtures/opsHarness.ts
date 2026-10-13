import { resolve } from 'node:path';
import { expect } from 'vitest';
import { RepoOperations, type RepoOperationsOptions } from '../../src/core/ops/operations';
import type { RebaseScript } from '../../src/core/rebase/rewrite';
import { RepoData } from '../../src/core/repo/repoData';
import { Repository } from '../../src/core/repo/repository';
import type { Operation, OperationResult } from '../../src/shared/operations';
import type { TestRepo } from './repoBuilder';

/** Lanefold's rebase sequence editor, run by this Node: history edits need it (`rebaseScript`). */
export const REBASE_SCRIPT: RebaseScript = {
  node: process.execPath,
  sequenceEditor: resolve('src/core/rebase/sequence-editor.cjs'),
};

/** A test repository opened for operations, as the backend opens one. */
export interface OpsHarness {
  readonly repo: Repository;
  readonly data: RepoData;
  readonly ops: RepoOperations;
  /** Plans `operation`, expects the plan not to be blocked (failing with its notices), and runs it. */
  run(operation: Operation): Promise<OperationResult>;
  /** Plans `operation` and runs the plan whatever it says: a blocked one comes back refused. */
  attempt(operation: Operation): Promise<OperationResult>;
  /** Disposes the operations and the data, then the test repository. */
  dispose(): Promise<void>;
}

/**
 * Opens `test` with its RepoData and RepoOperations (`options` are the operations': history
 * edits need `{ rebaseScript: REBASE_SCRIPT }`). Its `dispose` disposes `test` too.
 */
export async function openOps(test: TestRepo, options: RepoOperationsOptions = {}): Promise<OpsHarness> {
  const repo = (await Repository.open(test.runner, test.path))!;
  const data = new RepoData(repo);
  const ops = new RepoOperations(repo, data, options);
  return {
    repo,
    data,
    ops,
    async run(operation) {
      const plan = await ops.plan(operation);
      expect(plan.blocked, plan.notices.map((notice) => notice.text).join('\n')).toBeFalsy();
      return ops.execute(plan.id);
    },
    async attempt(operation) {
      return ops.execute((await ops.plan(operation)).id);
    },
    async dispose() {
      ops.dispose();
      data.dispose();
      await test.dispose();
    },
  };
}
