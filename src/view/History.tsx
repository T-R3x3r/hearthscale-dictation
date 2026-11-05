/**
 * The history at the tray icon: each dictation this computer keeps, to copy
 * again or remove. It also holds the text that could not be inserted.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  EmptyState,
  Icon,
  IconButton,
  ListRow,
  Notice,
  OverlayScroll,
  useFloatingTips,
} from '@hearthscale/app-ui';
import type { Entry, History as Kept } from '../shared/types.ts';
import { words, type Host } from './host.ts';

function Row({
  entry,
  locale,
  host,
  gone,
}: {
  entry: Entry;
  locale: string;
  host: Host;
  gone: () => void;
}) {
  const tips = useFloatingTips();
  const copy = tips('copy', 'Copy');
  const remove = tips('remove', 'Remove');
  const when = new Date(entry.at).toLocaleString(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return (
    <ListRow
      title={<span className="history-text">{entry.text}</span>}
      sub={entry.program ? `${when}, ${entry.program}` : when}
      actions={
        <>
          <IconButton
            aria-label="Copy"
            {...copy.hover}
            onClick={() => void navigator.clipboard.writeText(entry.text)}
          >
            <Icon name="file-copy-line" size={14} />
          </IconButton>
          <IconButton
            aria-label="Remove"
            {...remove.hover}
            onClick={() => void host.tool('forget', { id: entry.id }).then(gone)}
          >
            <Icon name="delete-bin-line" size={14} />
          </IconButton>
          {copy.tip}
          {remove.tip}
        </>
      }
    />
  );
}

export function History({ host, locale }: { host: Host; locale: string }) {
  const [kept, setKept] = useState<Kept | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(() => {
    void host
      .tool<Kept>('history')
      .then(setKept)
      .catch((e) => setProblem(words(e)));
  }, [host]);

  useEffect(() => {
    load();
    return host.on('history', load);
  }, [host, load]);

  if (problem) return <Notice>{problem}</Notice>;
  if (!kept) return null;
  if (kept.entries.length === 0) {
    return (
      <EmptyState
        icon={<Icon name="mic-line" size={24} />}
        title={kept.keeps ? 'No dictations yet' : 'History is off'}
      />
    );
  }
  return (
    <OverlayScroll className="history-list">
      {kept.entries.map((entry) => (
        <Row key={entry.id} entry={entry} locale={locale} host={host} gone={load} />
      ))}
    </OverlayScroll>
  );
}
