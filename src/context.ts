import * as vscode from 'vscode';
import { RepositoryManager } from './git/manager';
import { Handler } from './host/webviewHost';

/** The Commit tool window, as other features see it (they add a tab's RPC handlers and push its events). */
export interface CommitViewBridge {
  /** Adds RPC handlers; they are registered on the current and every later webview connection. */
  addHandlers(handlers: Record<string, Handler>): void;
  post(name: string, data?: unknown): void;
  /** Reveals the tool window and selects a tab. */
  reveal(tab?: 'commit' | 'shelf' | 'stash' | 'branches'): Promise<void>;
}

/** Services shared by all features. */
export interface Ctx {
  extension: vscode.ExtensionContext;
  repos: RepositoryManager;
  /** Registers a command and keeps its disposable. Errors are shown as notifications. */
  command(id: string, fn: (...args: any[]) => unknown): void;
  /** Set by the commit feature, which registers first. */
  commitView?: CommitViewBridge;
}
