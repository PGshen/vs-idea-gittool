interface FileUri {
  scheme: string;
  authority: string;
  fsPath: string;
}

interface AnnotationRepository {
  relPath(file: string): string;
}

/** Only native files and files on this workspace's remote host can be passed to Git. */
export async function workingTreeAnnotation<R extends AnnotationRepository>(
  repos: { ready(): Promise<void>; getForFile(file: string): R | undefined },
  uri: FileUri,
  folders: readonly { uri: Pick<FileUri, 'scheme' | 'authority'> }[],
): Promise<{ repo: R; path: string } | undefined> {
  const remoteFile = uri.scheme === 'vscode-remote' && !!uri.authority &&
    folders.some(folder => folder.uri.scheme === 'vscode-remote' && folder.uri.authority === uri.authority);
  if (uri.scheme !== 'file' && !remoteFile) return undefined;
  await repos.ready();
  const repo = repos.getForFile(uri.fsPath);
  return repo ? { repo, path: repo.relPath(uri.fsPath) } : undefined;
}
