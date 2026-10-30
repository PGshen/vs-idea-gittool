// Shared UI text uses a translator supplied by its caller. Host and webview translators use the selected language
// bundle; see l10n/README.md.

export type Translate = (message: string, ...args: (string | number | boolean)[]) => string;

let bundle: Record<string, string> | undefined;

export function setTranslationBundle(translations: Record<string, string> | undefined) {
  bundle = translations;
}

export function getTranslationBundle() {
  return bundle;
}

/** Translates an English UI string and fills its {n} placeholders. */
export const translate: Translate = (message, ...args) => {
  const text = bundle?.[message] ?? message;
  return text.replace(/\{(\d+)\}/g, (m, i) => (i < args.length ? String(args[i]) : m));
};

/** The English text with the {n} placeholders filled in. */
export const english: Translate = (message, ...args) => message.replace(/\{(\d+)\}/g, (m, i) => (i < args.length ? String(args[i]) : m));
