import { describe, expect, it } from 'vitest';
import { cloneFolderName } from '../../src/core/repo/clone';

describe('clone folder names', () => {
  it('takes the last part of the URL without .git, like git does', () => {
    expect(cloneFolderName('https://github.com/owner/app.git')).toBe('app');
    expect(cloneFolderName('https://github.com/owner/app/')).toBe('app');
    expect(cloneFolderName('git@github.com:owner/tool.git')).toBe('tool');
    expect(cloneFolderName('ssh://host/srv/repos/thing.git/')).toBe('thing');
    expect(cloneFolderName('/home/me/projects/local')).toBe('local');
    expect(cloneFolderName('C:\\work\\repo.git')).toBe('repo');
    expect(cloneFolderName('..')).toBe('repository');
  });
});
