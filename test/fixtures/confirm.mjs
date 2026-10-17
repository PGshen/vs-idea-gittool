export const initial = { kind: 'confirm', title: 'Delete Branch', props: { title: 'Delete Branch', message: 'Delete branch "feature/foo"?\nThe branch is not fully merged.', icon: 'warning', buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'delete', label: 'Delete', primary: true }], checkbox: 'Delete tracked remote branch' } };
export async function handle() { return { ok: true }; }
