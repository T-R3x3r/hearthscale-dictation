/**
 * The history's start: it connects to its host and shows the list, at the tray icon
 * in a window of the size it asks for, and over Settings in a dialog.
 */
import { createRoot } from 'react-dom/client';
import { App, PostMessageTransport } from '@modelcontextprotocol/ext-apps';
import { hostCall } from '@hearthscale/app/view';
import { Modal } from '@hearthscale/app-ui';
import { Host } from './host.ts';
import { History } from './History.tsx';
import sheet from './ui.css?inline';

/** The size of the history at the tray icon, in points. */
const WIDTH = 400;
const HEIGHT = 480;
/** The width of the dialog over Settings, in points. */
const DIALOG_WIDTH = 480;

const style = document.createElement('style');
style.textContent = sheet;
document.head.append(style);

const app = new App({ name: 'Dictation history', version: '0.1.1' }, {}, { autoResize: false });
const host = new Host(app);
await app.connect(new PostMessageTransport(window.parent, window.parent));

const context = app.getHostContext() ?? {};
const atTray = context.displayMode === 'pip';
if (atTray) void app.sendSizeChanged({ width: WIDTH, height: HEIGHT });
const root = document.createElement('div');
root.className = 'history-root';
root.dataset.place = atTray ? 'tray' : 'dialog';
document.body.append(root);
const list = <History host={host} locale={context.locale ?? navigator.language} />;
const close = () => void hostCall(app as never)('hearthscale/ui/close-modal', {});
createRoot(root).render(
  atTray ? (
    list
  ) : (
    <Modal title="History" onClose={close} width={DIALOG_WIDTH} scrim={false}>
      <div className="history-dialog">{list}</div>
    </Modal>
  ),
);
