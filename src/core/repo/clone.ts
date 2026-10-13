/** The folder name git would pick ("https://host/team/app.git" → "app"). */
export function cloneFolderName(url: string): string {
  const name = url
    .trim()
    .replace(/[\\/]+$/, '')
    .replace(/\.git$/, '')
    .split(/[\\/:]/)
    .filter(Boolean)
    .at(-1);
  return name && name !== '.' && name !== '..' ? name : 'repository';
}
