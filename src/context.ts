import * as vscode from 'vscode';
import { RepositoryManager } from './git/manager';

/** Services shared by all features. */
export interface Ctx {
  extension: vscode.ExtensionContext;
  repos: RepositoryManager;
  /** Registers a command and keeps its disposable. Errors are shown as notifications. */
  command(id: string, fn: (...args: any[]) => unknown): void;
}
