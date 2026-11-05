/**
 * The history's start: it connects to its host, shows the list and takes the
 * size it needs at the tray icon.
 */
import { createRoot } from 'react-dom/client';
import { App, PostMessageTransport } from '@modelcontextprotocol/ext-apps';
import { Host } from './host.ts';
import { History } from './History.tsx';
import sheet from './ui.css?inline';

/** The size of the history at the tray icon, in points. */
const WIDTH = 400;
const HEIGHT = 480;

const style = document.createElement('style');
style.textContent = sheet;
document.head.append(style);

const app = new App({ name: 'Dictation history', version: '0.1.0' }, {}, { autoResize: false });
const host = new Host(app);
await app.connect(new PostMessageTransport(window.parent, window.parent));
void app.sendSizeChanged({ width: WIDTH, height: HEIGHT });

const context = app.getHostContext() ?? {};
const root = document.createElement('div');
root.className = 'history-root';
document.body.append(root);
createRoot(root).render(<History host={host} locale={context.locale ?? navigator.language} />);
