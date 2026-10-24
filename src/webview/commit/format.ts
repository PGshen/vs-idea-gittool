import { t } from '../lib/l10n';

/** Date like IntelliJ's DateFormatUtil.formatPrettyDateTime: "Today 6:56 pm", "Yesterday …", or "17/6/26, 6:56 pm". */
export function formatDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, now)) return t('Today {0}', time);
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return t('Yesterday {0}', time);
  return `${d.getDate()}/${d.getMonth() + 1}/${String(d.getFullYear()).slice(2)}, ${time}`;
}
