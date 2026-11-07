/**
 * The history at the tray icon: each dictation this computer keeps, to copy
 * again or remove, and the last text that reached no program.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Button,
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

function Row({ text, sub, remove }: { text: string; sub?: string; remove?: () => void }) {
  const tips = useFloatingTips();
  const copy = tips('copy', 'Copy');
  const removal = tips('remove', 'Remove');
  return (
    <ListRow
      title={<span className="history-text">{text}</span>}
      {...(sub && { sub })}
      actions={
        <>
          <IconButton
            aria-label="Copy"
            {...copy.hover}
            onClick={() => void navigator.clipboard.writeText(text)}
          >
            <Icon name="file-copy-line" size={14} />
          </IconButton>
          {remove && (
            <IconButton aria-label="Remove" {...removal.hover} onClick={remove}>
              <Icon name="delete-bin-line" size={14} />
            </IconButton>
          )}
          {copy.tip}
          {removal.tip}
        </>
      }
    />
  );
}

function subOf(entry: Entry, locale: string): string {
  const when = new Date(entry.at).toLocaleString(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return entry.program ? `${when}, ${entry.program}` : when;
}

export function History({ host, locale }: { host: Host; locale: string }) {
  const [kept, setKept] = useState<Kept | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [hearing, setHearing] = useState(false);
  const [notHeard, setNotHeard] = useState<string | null>(null);

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

  const again = () => {
    setHearing(true);
    setNotHeard(null);
    void host
      .tool('hear_again')
      .catch((e: unknown) => setNotHeard(words(e)))
      .finally(() => {
        setHearing(false);
        load();
      });
  };

  if (problem) return <Notice>{problem}</Notice>;
  if (!kept) return null;
  const failed = kept.failed && (
    <div className="history-again">
      <span>{notHeard ?? 'The last dictation did not finish.'}</span>
      <Button disabled={hearing} onClick={again}>
        Try again
      </Button>
    </div>
  );
  if (kept.entries.length === 0 && kept.text === null) {
    return (
      <>
        {failed}
        <EmptyState
          icon={<Icon name="mic-line" size={24} />}
          title={kept.keeps ? 'No dictations yet' : 'History is off'}
        />
      </>
    );
  }
  return (
    <OverlayScroll className="history-list">
      {failed}
      {kept.text !== null && <Row text={kept.text} />}
      {kept.entries.map((entry) => (
        <Row
          key={entry.id}
          text={entry.text}
          sub={subOf(entry, locale)}
          remove={() => void host.tool('forget', { id: entry.id }).then(load)}
        />
      ))}
    </OverlayScroll>
  );
}
