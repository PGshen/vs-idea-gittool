// Preview of the log dialogs: New Commit Message (Extract Selected Changes to Separate Commit…).
export const initial = {
  kind: 'log.newCommitMessage',
  title: 'New Commit Message',
  props: { label: 'Changes extracted from commit c1c9c29a by detachhead', message: 'fixes from merge\n\nmore details here' },
};

export async function handle() {
  return { ok: true };
}
