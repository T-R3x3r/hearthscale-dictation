/**
 * The microphone test over Settings: record up to ten seconds, see the level, and
 * hear it back. The sound stays on this computer and no model hears it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App, PostMessageTransport } from '@modelcontextprotocol/ext-apps';
import { hostCall } from '@hearthscale/app/view';
import { Button, Icon, Modal, Notice } from '@hearthscale/app-ui';
import { Host, words } from './host.ts';
import sheet from './ui.css?inline';

const RATE = 16_000;
const LONGEST_SECONDS = 10;
const WIDTH = 440;

type Phase = 'idle' | 'recording' | 'ready' | 'playing';

function fromBase64(text: string): Int16Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
  return new Int16Array(bytes.buffer, 0, bytes.length >> 1);
}

function MicTest({ host, onClose }: { host: Host; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [level, setLevel] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const player = useRef<AudioContext | null>(null);
  const playing = useRef<AudioBufferSourceNode | null>(null);

  const readyWhenStopped = useCallback(() => {
    setLevel(0);
    setPhase((held) => (held === 'recording' ? 'ready' : held));
  }, []);

  useEffect(
    () =>
      host.on('mic-test', (data) => {
        const told = data as { recording: boolean; level?: number; seconds?: number };
        if (!told.recording) {
          readyWhenStopped();
          return;
        }
        setLevel(told.level ?? 0);
        setSeconds(told.seconds ?? 0);
      }),
    [host, readyWhenStopped],
  );

  const start = () => {
    setProblem(null);
    setSeconds(0);
    setPhase('recording');
    void host.tool('mic_test_start').catch((e: unknown) => {
      setProblem(words(e));
      setPhase('idle');
    });
  };

  const stop = () => void host.tool('mic_test_stop').then(readyWhenStopped);

  const play = async () => {
    setProblem(null);
    try {
      const { pcm } = await host.tool<{ pcm: string }>('mic_test_sound');
      const samples = fromBase64(pcm);
      if (samples.length === 0) {
        setProblem('No sound was recorded.');
        return;
      }
      player.current ??= new AudioContext();
      const buffer = player.current.createBuffer(1, samples.length, RATE);
      const channel = buffer.getChannelData(0);
      samples.forEach((sample, at) => {
        channel[at] = sample / 32768;
      });
      const source = player.current.createBufferSource();
      source.buffer = buffer;
      source.connect(player.current.destination);
      source.onended = () => setPhase('ready');
      playing.current = source;
      setPhase('playing');
      source.start();
    } catch (e) {
      setProblem(words(e));
      setPhase('ready');
    }
  };

  return (
    <Modal title="Test microphone" onClose={onClose} width={WIDTH} scrim={false}>
      <div className="mic-test-body">
        <div
          className="mic-test-meter"
          role="meter"
          aria-label="Microphone level"
          aria-valuenow={level}
        >
          <span style={{ transform: `scaleX(${level})` }} />
        </div>
        <span className="mic-test-time">
          {seconds.toFixed(0)} s of {LONGEST_SECONDS} s
        </span>
        {problem && <Notice>{problem}</Notice>}
        <div className="mic-test-actions">
          {phase === 'recording' ? (
            <Button variant="primary" onClick={stop}>
              Stop
            </Button>
          ) : (
            <Button
              variant={phase === 'idle' ? 'primary' : 'secondary'}
              icon={<Icon name="mic-line" size={13} />}
              disabled={phase === 'playing'}
              onClick={start}
            >
              {phase === 'idle' ? 'Record' : 'Record again'}
            </Button>
          )}
          {phase === 'playing' && (
            <Button
              variant="primary"
              icon={<Icon name="stop-line" size={13} />}
              onClick={() => playing.current?.stop()}
            >
              Stop
            </Button>
          )}
          {phase === 'ready' && (
            <Button
              variant="primary"
              icon={<Icon name="play-line" size={13} />}
              onClick={() => void play()}
            >
              Play
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

const style = document.createElement('style');
style.textContent = sheet;
document.head.append(style);

const app = new App({ name: 'Microphone test', version: '0.1.0' }, {}, { autoResize: false });
const host = new Host(app);
const call = hostCall(app as never);
await app.connect(new PostMessageTransport(window.parent, window.parent));
const root = document.createElement('div');
document.body.append(root);
const close = () => {
  void host
    .tool('mic_test_stop')
    .catch(() => {})
    .finally(() => void call('hearthscale/ui/close-modal', {}));
};
createRoot(root).render(<MicTest host={host} onClose={close} />);
