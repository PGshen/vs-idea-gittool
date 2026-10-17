import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { RowData } from '../../shared/logProtocol';
import { anchorAt } from '../lib/menu';
import { call } from '../lib/rpc';
import { Icon, useDark } from '../lib/icons';
import { GraphCell, graphWidth, ROW_H } from './graph';
import { commitMenu, runCommitAction } from './menus';
import { refLabels, RefLabels } from './refs';
import { store, useStore } from './store';

const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' });

export function formatDate(sec: number) {
  return fmt.format(new Date(sec * 1000)).replace(/\s?(AM|PM)$/, m => m.toLowerCase());
}

/** VcsLogColorManagerFactory.NEW_UI_ROOT_COLORS_OPENED_STATE (light, dark). */
const ROOT_COLORS: [string, string][] = [
  ['#FFE3EA', '#603239'], ['#E3F7E7', '#375239'], ['#E3E1F7', '#383275'], ['#FFEFE3', '#614438'], ['#D5ECEB', '#1D4D4A'],
  ['#FFF5DB', '#5E4D33'], ['#FEE4FF', '#562B58'], ['#E8E2DD', '#624E3F'], ['#D5F2E8', '#0D573C'], ['#EFE5FF', '#3B3147'],
  ['#DAF4F5', '#204145'], ['#ECE0EC', '#503250'], ['#FDF0D7', '#594D36'], ['#EBECF0', '#494B57'],
];

export function rootColor(index: number, dark: boolean) {
  const c = ROOT_COLORS[index % ROOT_COLORS.length];
  return dark ? c[1] : c[0];
}

const SIGNATURE_TEXT: Record<string, string> = {
  G: 'Verified signature',
  U: 'Signature with unknown validity',
  X: 'Expired signature',
  Y: 'Signature made by an expired key',
  R: 'Signature made by a revoked key',
  E: 'Signature cannot be checked',
  B: 'Bad signature',
};

/** GPG Signature column cell (git4idea GitCommitSignatureLogColumn). */
function SignatureCell({ hash, width }: { hash: string; width: number }) {
  const sig = store.signatures.get(hash);
  const text = sig && sig.status !== 'N' ? `${SIGNATURE_TEXT[sig.status] ?? 'Signed'}${sig.signer ? `\n${sig.signer}` : ''}${sig.key ? `\nKey: ${sig.key}` : ''}` : undefined;
  return (
    <div class="cell signature" style={{ width: `${width}px` }} data-tip={text}>
      {sig && sig.status === 'G' && <Icon name="git/verified" />}
      {sig && sig.status !== 'G' && sig.status !== 'N' && <Icon name="git/signed" />}
    </div>
  );
}

/** Navigates to a commit by hash (long edge arrows). */
async function jumpTo(hash: string) {
  const i = store.indexOfHash(hash);
  if (i >= 0) return store.selectIndex(i);
  const r = await call<{ index: number; hash: string } | undefined>('find', hash);
  if (r) await store.selectIndex(r.index, { hash: r.hash });
}

function isMine(r: RowData) {
  const me = store.init.me;
  return (me.email && r.ae === me.email) || (me.name && r.an === me.name);
}

/** The commit table (VcsLogGraphTable): graph + subject with references, author, date, hash. */
export function LogTable() {
  const s = useStore();
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const [width, setWidth] = useState(800);
  const [sbw, setSbw] = useState(0);
  const settings = s.settings;
  const dark = useDark();

  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => {
      setHeight(el.clientHeight);
      setWidth(el.clientWidth);
      setSbw(el.offsetWidth - el.clientWidth);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Scroll requests from the store (navigation, keyboard).
  useEffect(() => {
    if (s.scrollTo === undefined) return;
    const el = ref.current!;
    const i = s.scrollTo;
    s.scrollTo = undefined;
    const top = i * ROW_H;
    if (top < el.scrollTop) el.scrollTop = Math.max(0, top - ROW_H * 2);
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H * 3 - el.clientHeight;
  });

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 10);
  const last = Math.min(s.total, Math.ceil((scrollTop + height) / ROW_H) + 10);

  useEffect(() => {
    void s.ensureRows(first, last + (s.done ? 0 : 1));
  }, [first, last, s.total, s.generation]);

  const visible: { i: number; r: RowData | undefined }[] = [];
  for (let i = first; i < last; i++) visible.push({ i, r: s.rows.get(i) });

  useEffect(() => {
    if (settings.columns.signature) void s.loadSignatures(visible.map(v => v.r?.h).filter((h): h is string => !!h));
  }, [first, last, s.rows.size, s.generation, settings.columns.signature]);

  const lanes = useMemo(() => Math.max(1, ...visible.map(v => v.r?.g.width ?? 1)), [first, last, s.rows.size, s.generation]);
  const gw = Math.min(graphWidth(lanes), Math.max(60, width * 0.4));
  const cols = settings.columns;
  const cw = settings.columnWidths;
  const currentBranch = s.currentBranch;
  const filteredToHead = s.filters.branches.length === 1 && (s.filters.branches[0] === 'HEAD' || s.filters.branches[0] === currentBranch);
  const highlightBranch = settings.highlightCurrentBranch && !filteredToHead && s.init.mode === 'log';

  const onKey = (e: KeyboardEvent) => {
    const i = s.lead;
    const page = Math.max(1, Math.floor(height / ROW_H) - 1);
    const go = (j: number) => {
      e.preventDefault();
      void s.selectIndex(Math.max(0, Math.min(s.total - 1, j)), { shift: e.shiftKey });
    };
    const ctrl = e.ctrlKey || e.metaKey;
    switch (e.key) {
      case 'ArrowDown':
        return go(i + 1);
      case 'ArrowUp':
        return go(i - 1);
      case 'PageDown':
        return go(i + page);
      case 'PageUp':
        return go(i - page);
      case 'Home':
        return go(0);
      case 'End':
        return go(s.total - 1);
      case 'ArrowRight':
        e.preventDefault();
        return void goToRelative('parent');
      case 'ArrowLeft':
        e.preventDefault();
        return void goToRelative('child');
      case 'Enter':
      case 'F4':
        e.preventDefault();
        return runCommitAction(store.init.mode === 'history' ? 'historyDiff' : 'showDiff');
      case 'F2':
        e.preventDefault();
        return runCommitAction('reword');
      case 'ContextMenu': {
        e.preventDefault();
        const row = ref.current!.querySelector('.log-row.selected');
        const r = row?.getBoundingClientRect();
        void commitMenu(r ? { x: r.left + 40, y: r.bottom } : { x: 100, y: 100 });
        return;
      }
    }
    if (ctrl && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      void call('copy', s.selectedRows().map(r => r.h).join(' '));
    } else if (ctrl && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      runCommitAction(store.init.mode === 'history' ? 'historyDiff' : 'showDiff');
    } else if (ctrl && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      void (async () => {
        await s.ensureRows(0, s.total);
        s.selection = new Set([...s.rows.values()].map(r => r.h));
        s.emit();
        s.scheduleDetails();
      })();
    }
  };

  const startResize = (col: 'author' | 'date' | 'hash', e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = cw[col];
    const move = (ev: MouseEvent) => {
      s.settings = { ...s.settings, columnWidths: { ...s.settings.columnWidths, [col]: Math.max(40, startW - (ev.clientX - startX)) } };
      s.emit();
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      s.updateSettings({});
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };

  // Right edges of the fixed columns, for the invisible resize handles.
  const resizers: { col: 'author' | 'date' | 'hash'; right: number }[] = [];
  let right = 6 + (cols.signature ? cw.signature : 0);
  if (cols.hash) {
    resizers.push({ col: 'hash', right: right + cw.hash });
    right += cw.hash;
  }
  if (cols.date) {
    resizers.push({ col: 'date', right: right + cw.date });
    right += cw.date;
  }
  if (cols.author) resizers.push({ col: 'author', right: right + cw.author });

  return (
    <div class="table-wrap">
      {s.loading && <div class="loading-bar" />}
      <div
        class="log-table"
        ref={ref}
        tabIndex={0}
        id="log-table"
        onScroll={e => setScrollTop((e.currentTarget as HTMLElement).scrollTop)}
        onKeyDown={onKey}
      >
        <div style={{ height: `${Math.max(s.total, 0) * ROW_H + 8}px`, position: 'relative' }}>
          {visible.map(({ i, r }) => {
            if (!r) return <div key={`p${i}`} class="log-row" style={{ top: `${i * ROW_H + 2}px` }} />;
            const labels = refLabels(r.refs, { compact: settings.compactRefs, showTagNames: settings.showTagNames, currentBranch });
            const merge = r.p.length > 1;
            const picked = !!s.cherryPick?.nonPicked && !s.cherryPick.nonPicked.has(r.h);
            const dim = merge || picked;
            const bold = (settings.highlightMyCommits && isMine(r)) || (settings.highlightMergeCommits && merge);
            const cls = [
              'log-row',
              s.selection.has(r.h) ? 'selected' : '',
              highlightBranch && r.b ? 'current-branch' : '',
              dim && (picked || !(settings.highlightMergeCommits && merge)) ? 'dim' : '',
              bold ? 'bold' : '',
            ].join(' ');
            const author = r.an + (r.an !== r.cn ? '*' : '');
            const date = settings.preferCommitDate ? r.ct : r.at;
            const repo = s.repoOf(r);
            return (
              <div
                key={r.h}
                class={cls}
                style={{ top: `${i * ROW_H + 2}px` }}
                onMouseDown={e => {
                  if (e.button === 2 && s.selection.has(r.h)) return;
                  void s.selectIndex(i, { shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey, noScroll: true });
                }}
                onDblClick={() => runCommitAction(store.init.mode === 'history' ? 'historyDiff' : 'showDiff')}
                onContextMenu={e => {
                  e.preventDefault();
                  void commitMenu(anchorAt(e));
                }}
              >
                {repo && (
                  <div
                    class={`cell root ${settings.showRootNames ? 'named' : ''}`}
                    style={{ background: rootColor(repo.color, dark) }}
                    data-tip={`${repo.name}\n${repo.root}`}
                  >
                    {settings.showRootNames ? repo.name : ''}
                  </div>
                )}
                <div class="cell subject">
                  <GraphCell row={r.g} width={gw} head={repo ? r.h === repo.head.hash : r.h === s.head.hash} onJump={h => void jumpTo(h)} />
                  {settings.refsOnLeft && <RefLabels labels={labels} left />}
                  <span class="subject-text" data-tip={r.s.length > 80 ? r.s : undefined}>
                    {r.s}
                  </span>
                  {!settings.refsOnLeft && <RefLabels labels={labels} />}
                </div>
                {cols.author && (
                  <div class="cell author" style={{ width: `${cw.author}px` }} data-tip={`${r.an} <${r.ae}>${r.an !== r.cn ? `\ncommitted by ${r.cn}` : ''}`}>
                    {author}
                  </div>
                )}
                {cols.date && (
                  <div class="cell date" style={{ width: `${cw.date}px` }}>
                    {formatDate(date)}
                  </div>
                )}
                {cols.hash && (
                  <div class="cell hash" style={{ width: `${cw.hash}px` }}>
                    {r.h.slice(0, 8)}
                  </div>
                )}
                {cols.signature && <SignatureCell hash={r.h} width={cw.signature} />}
              </div>
            );
          })}
        </div>
      </div>
      {resizers.map(rz => (
        <div key={rz.col} class="col-resizer" style={{ right: `${rz.right + sbw - 3}px` }} onMouseDown={e => startResize(rz.col, e)} />
      ))}
      {!s.loading && s.total === 0 && (
        <div class="table-status">
          {s.error ? <span class="error-text">{s.error}</span> : s.filters.text || s.filters.users.length || s.filters.paths.length || s.filters.branches.length || s.filters.since || s.filters.until ? (
            <>
              No commits matching filters
              <br />
              <span class="link" onClick={() => void s.setFilters({ ...s.filters, branches: [], users: [], paths: [], text: '', since: undefined, until: undefined })}>
                Reset filters
              </span>
            </>
          ) : (
            <>
              No changes committed.
              <br />
              <span class="link" onClick={() => void call('command', { id: 'rebased.commit' })}>
                Commit local changes
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Go to Parent / Child Commit (Right / Left keys). */
export async function goToRelative(dir: 'parent' | 'child') {
  const s = store;
  const row = s.rows.get(s.lead);
  if (!row) return;
  if (dir === 'parent') {
    const p = row.p[0];
    if (!p) return;
    let i = s.indexOfHash(p);
    for (let n = 0; i < 0 && n < 20 && !s.done; n++) {
      await s.ensureRows(s.lead, s.lead + 400 * (n + 1));
      i = s.indexOfHash(p);
    }
    if (i >= 0) await s.selectIndex(i);
  } else {
    for (let i = s.lead - 1; i >= 0; i--) {
      const r = s.rows.get(i);
      if (r?.p.includes(row.h)) return s.selectIndex(i);
    }
  }
}
