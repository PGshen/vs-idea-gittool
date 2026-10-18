// Fixture for the Local History window (node scripts/preview.mjs localHistory test/fixtures/localHistory.mjs out.png).
const now = Date.now();
const h = 3600_000;
export const initial = { mode: 'file', displayName: 'IdeaGitToolProperties.kt', showSystem: true };

const items = [
  { id: 9, lastId: 9, ts: now - 0.2 * h, kind: 'change', title: 'Change', files: 1, paths: ['build/src/IdeaGitToolProperties.kt'] },
  { id: 8, lastId: 8, ts: now - 1.1 * h, kind: 'system', title: 'Before Update', files: 0, paths: [] },
  { id: 7, lastId: 7, ts: now - 1.5 * h, kind: 'external', title: 'External change', files: 1, paths: ['build/src/IdeaGitToolProperties.kt'] },
  { id: 5, lastId: 5, ts: now - 2.5 * h, kind: 'label', title: 'Before refactoring', files: 0, paths: [] },
  { id: 4, lastId: 4, ts: now - 26 * h, kind: 'change', title: 'Change', files: 1, paths: ['build/src/IdeaGitToolProperties.kt'] },
  { id: 1, lastId: 1, ts: now - 50 * h, kind: 'change', title: 'Create IdeaGitToolProperties.kt', files: 1, paths: ['build/src/IdeaGitToolProperties.kt'] },
];

const before = `package org.jetbrains.intellij.build

import org.jetbrains.intellij.build.productLayout.ProductModulesLayout

class IdeaGitToolProperties(home: Path) : BaseIdeaProperties() {
  override val baseFileName = "idea"
  init {
    platformPrefix = "Idea"
    applicationInfoModule = "intellij.idea.community.customization"
    scrambleMainJar = false
  }
}
`;
const after = `package org.jetbrains.intellij.build

import java.nio.file.Path
import org.jetbrains.intellij.build.productLayout.ProductModulesLayout

class IdeaGitToolProperties(home: Path) : BaseIdeaProperties() {
  override val baseFileName = "ideagittool"
  init {
    platformPrefix = "Idea"
    applicationInfoModule = "intellij.idea.community.customization"
    productLayout.bundledPluginModules = listOf("intellij.vcs.git")
  }
}
`;

export async function handle(method) {
  if (method === 'items') return items;
  if (method === 'diff') return { kind: 'text', left: { title: 'Before Oct 17, 2026, 7:30 AM', text: before }, right: { title: 'Current', text: after } };
  return null;
}
