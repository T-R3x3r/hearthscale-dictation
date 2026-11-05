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
| `src/hud/` | The view over other programs, with no framework. |
| `src/view/` | The history at the tray icon, React on the kit's parts. |
| `views/` | The views' builds, the files the package carries for them, committed with every change. |

## Build

```sh
pnpm install
pnpm build
```

## How a dictation runs

1. A press starts the capture at once and opens the stream beside it. The parts wait for the stream, so a model's cold start loses no word.
2. Each part of 100 ms goes to the stream, and its loudness and five bands go to the HUD as an event that is not kept.
3. The chat model warms up while the person speaks, for a cold load takes up to 9 s.
4. At the end, the stop hands over the last part, and the stream's `done` follows the last segment.
5. Fewer than 200 ms of voice is no speech, whatever the model made of it. Models write `Thank you.` or `The.` on silence.
6. The clean up runs on the whole text, with the transcript in tags, which keeps a model from answering a dictated question. A length guard keeps the heard text when the answer strays from it.
7. A text of one line up to 200 characters is typed; any other is pasted, for a typed line break is the Enter key, which sends a message in a chat program. A terminal gets one line.

The stream runs with `pauses: false`. A pause would cut a sentence on a model that streams, and take its punctuation.

## Measured

On an RTX 3080, from the key's release to the text in the program, with Parakeet TDT v3 and Gemma 4 E2B: 0.5 to 0.9 s at 4 s of speech, 1.3 s for the first dictation with everything cold, and 3.3 s at 34 s of speech.
