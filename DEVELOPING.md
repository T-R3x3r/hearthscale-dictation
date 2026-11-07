# Developing Dictation

`README.md` is the text the Marketplace shows under **About** on the listing of Dictation, so it is written for the person who installs the app. This file is for developers.

Dictation is a headless Hearthscale app, built only on the platform's documented API: no rail button and no tab. Its keys, models and choices sit on its page in Settings, and it shows only the HUD over other programs and the history at the tray icon.

## Layout

| Path | What it holds |
| --- | --- |
| `app.json` | The manifest. |
| `backend.ts` | The backend's entry; `hearthscale dev` and `pack` bundle it with `src/backend` and `src/shared`. |
| `src/backend/main.ts` | The keys, the flow of one dictation, the insert and the history. |
| `src/backend/listening.ts` | The microphone and the transcription stream of one dictation. |
| `src/backend/cleanup.ts` | The clean up by the chat model. |
| `src/backend/words.ts` | The dictionary's entries, and the text steps that need no model. |
| `src/backend/micTest.ts` | The recording of the microphone test. |
| `src/backend/recommend.ts` | Which speech models the app recommends, from what each card measured. |
| `src/hud/` | The view over other programs, with no framework. |
| `src/view/` | The history at the tray icon and the microphone test, React on the kit's parts. |
| `views/` | The views' builds, the files the package carries for them, committed with every change. |

## Build

```sh
pnpm install
pnpm build
```

`package.json` takes the SDK packages, `@hearthscale/app` and `@hearthscale/app-ui`, from a Hearthscale checkout beside this folder, `../Hearthscale-mxc`.

## How a dictation runs

1. A press starts the capture at once and opens the stream beside it. The parts wait for the stream, so a model's cold start loses no word.
2. Each part of 100 ms goes to the stream, and its loudness and five bands go to the HUD as an event that is not kept.
3. The chat model warms up while the person speaks, for a cold load takes up to 9 s.
4. At the end, the stop hands over the last part, and the stream's `done` follows the last segment. The microphone stops at the end, also while an earlier text is on its way.
5. Fewer than 200 ms of voice is no speech, whatever the model made of it. Models write `Thank you.` or `The.` on silence.
6. The clean up runs on the whole text, with the transcript in tags, which keeps a model from answering a dictated question, and the text around the cursor in untrusted parts. A length guard keeps the heard text when the answer strays from it, and any stop but `end_turn` keeps it too. A cloud model runs only where the person chose it for the app.
7. A text of one line up to 200 characters is typed; any other is pasted, for a typed line break is the Enter key, which sends a message in a chat program. With **Type**, a text over 2,000 characters is pasted. A terminal, or a program not yet known, gets one line.
8. The text goes to the window in front when the person ended the dictation, and no other: a window that comes to the front later gets nothing. The text stays in History, or in memory with the history off, until the next text lands.
9. A press while a text is on its way starts the next dictation at once. The texts land in order, each once the keys are up.
10. A dictation ends after 60 s with no voice, or after 10 min. With no press to end it, the text goes only to History. A model that does not answer ends the wait, from the release on, and a clean up that takes over 30 s leaves the heard text.

Escape is a hotkey with `armed: false`, held only while a dictation runs or a text is on its way. While a dictation hears, it drops it. Until the clean up starts, it drops the text. During the clean up, it skips it. A clean up that repeats the text around the cursor runs again without that text, and one whose words the person did not say keeps the heard words: a translation, an answer to a dictated request, or an example from the instructions. A dictation that fails types nothing, and its sound stays in memory until the next text lands, so History can hear it again.

The stream runs with `pauses: false`. A pause would cut a sentence on a model that streams, and take its punctuation.

## Measured

On an RTX 3080, from the key's release to the text in the program, with Parakeet TDT v3 and Gemma 4 E2B: 0.5 to 0.9 s at 4 s of speech, 1.3 s for the first dictation with everything cold, and 3.3 s at 34 s of speech.
