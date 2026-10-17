// Port of IntelliJ's MergeResolveUtilTest (platform/diff-impl/tests/.../comparison/MergeResolveUtilTest.kt).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tryGreedyResolve, tryResolve } from '../src/shared/mergeResolve';

const simple = (base: string, left: string, right: string, expected: string | null) =>
  assert.equal(tryResolve(left, base, right) ?? null, expected, `simple: ${JSON.stringify([base, left, right])}`);
const greedy = (base: string, left: string, right: string, expected: string | null) =>
  assert.equal(tryGreedyResolve(left, base, right) ?? null, expected, `greedy: ${JSON.stringify([base, left, right])}`);
const both = (base: string, left: string, right: string, expectedSimple: string | null, expectedGreedy = expectedSimple) => {
  simple(base, left, right, expectedSimple);
  greedy(base, left, right, expectedGreedy);
};

test('simple', () => {
  both('', '', '', '');
  both('x x x', 'x x x', 'x x x', 'x x x');
  both('x x x', 'x Y x', 'x x x', 'x Y x');
  both('x x', 'x x', 'x Y x', 'x Y x');
  both('x X x', 'x x', 'x X x', 'x x');
});

test('same modification', () => {
  both('x x x', 'x Y x', 'x Y x', 'x Y x');
  both('x x', 'x Y x', 'x Y x', 'x Y x');
  both('x X x', 'x x', 'x x', 'x x');
});

test('non conflicting changes', () => {
  both('x x x', 'x Y x x', 'x x Z x', 'x Y x Z x');
  both('x', 'x Y', 'Z x', 'Z x Y');
  both('x x', 'x', 'Z x x', 'Z x');
});

test('failure', () => {
  both('x x x', 'x Y x', 'x Z x', null);
  both('x x', 'x Y x', 'x Z x', null);
});

test('non failure conflicts (greedy)', () => {
  greedy('x X x', 'x x', 'x X Y x', 'x Y x');
  greedy('x X x', 'x x', 'x Y X x', 'x Y x');
  greedy('x X Y x', 'x X x', 'x Y x', 'x x');
  greedy('x X Y Z x', 'x X x', 'x Z x', 'x x');
  greedy('x A B C D E F G H K x', 'x C F K x', 'x A D H x', 'x x');
});

test('confusing conflicts', () => {
  greedy('x X x', 'x x', 'x Z x', 'xZ x');
  greedy('x X X x', 'x X Y X x', 'x x', 'x Y x');
  greedy('x X x', 'x x', 'x Y x', 'xY x');
  greedy('x X X x', 'x Y x', 'x X Y x', 'x Y x');
  // IDEA-200696
  both('version: 1.0.0', 'version: 2.0.0', 'version: 1.0.4', 'version: 2.0.4');
});

test('regressions', () => {
  both('i\n', 'i', '\ni', 'i', 'i');
  simple('Y X Y', 'Y C\nX\nC Y', 'Y \nX\n Y', 'Y \nC\nX\nC Y');
  both(
    `
  public static class ChangeData {
    @NotNull public final ChangeKind kind;
    public final int otherPath;

    public ChangeData(@NotNull ChangeKind kind, int otherPath) {
      this.kind = kind;
      this.otherPath = otherPath;
    }

    public boolean isRename() {
      return kind.equals(ChangeKind.RENAMED_FROM) || kind.equals(ChangeKind.RENAMED_TO);
    }

    @Override
    public int hashCode() {
      return Objects.hash(kind, otherPath);
    }
  }

  private enum ChangeKind {
    MODIFIED((byte)0),
    RENAMED_FROM((byte)1),
    RENAMED_TO((byte)2);`,
    `
  public enum ChangeKind {
    NOT_CHANGED((byte)-1),
    MODIFIED((byte)0),
    ADDED((byte)1),
    REMOVED((byte)2);`,
    `
  public static class ChangeData {
  @NotNull public final ChangeKind kind;
  public final int otherPath;

  public ChangeData(@NotNull ChangeKind kind, int otherPath) {
    this.kind = kind;
    this.otherPath = otherPath;
  }

  public boolean isRename() {
    return kind.equals(ChangeKind.RENAMED_FROM) || kind.equals(ChangeKind.RENAMED_TO);
  }

  @Override
  public int hashCode() {
    return Objects.hash(kind, otherPath);
  }
}

private enum ChangeKind {
  MODIFIED((byte)0),
  RENAMED_FROM((byte)1),
  RENAMED_TO((byte)2);`,
    `
  public enum ChangeKind {
    NOT_CHANGED((byte)-1),
  MODIFIED((byte)0),
  ADDED((byte)1),
  REMOVED((byte)2);`,
  );
});
