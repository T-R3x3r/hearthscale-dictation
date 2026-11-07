# Dictation

Hold a key and speak. Clean text appears in the program in front. Your models stay on your device, or on a Server you paired. A cloud model is used only if you choose it for Dictation.

Free, with no account.

## Get started

There is no window to open. Download the models offered in the introduction, then hold **Ctrl+Shift+Space** in any program and speak. Let go, and the text appears where you were typing, in any supported language.

- **Live words** appear as you speak if your speech model has streaming. With any other model, the whole text appears when you let go.
- **Clean up** removes filler words and false starts, keeps your last correction and fixes the punctuation. Clean up uses your default chat model, unless that model is in the cloud. To use a cloud model, choose it under **Models** in **Settings > Apps > Dictation**.
- **History** keeps each dictation on this device, so you can copy it again. Choose **Open** beside **Keep history** in Settings, or **Dictation: History** from the tray icon. Turn it off in Settings, and the history is deleted.

## Keys

Change the keys in **Settings > Apps > Dictation**. Choose a combination, or one key alone, such as Right Ctrl or Right Alt.

Under **Key behaviour**:

- **Hold or tap** ends the dictation when you let go, or at the next press after a quick tap.
- **Hold** ends the dictation when you let go.
- **Tap** starts and ends the dictation with a press each.

Press **Esc** while you speak to drop the dictation. After you let go, **Esc** drops the words until the clean up starts. During the clean up, **Esc** skips it, and the words go in unchanged. At any other moment, Esc works as usual.

With one key alone, press another key with it to cancel the dictation. Ctrl+C still copies.

A dictation ends after 10 minutes, or after 60 seconds of silence. The text then goes to History and is not typed.

## Linux

The first time you use Dictation, enter your password when asked. This gives access to your keyboard in every program. To do this by hand, or if you choose Cancel, see the note beside **Keys for dictate** in **Settings > Apps > Dictation**.

The keys you hold also reach the program in front. Right Ctrl or a mouse button types nothing there, so these work well in a terminal.

The text goes in through the clipboard. Your clipboard is restored a moment later, except for copied files. On Wayland, in a GTK program such as GNOME Text Editor, new text goes in beside selected text and does not replace it.

## Models

- **A speech model** is required to turn speech into text. Under **Models** in **Settings > Apps > Dictation**, choose your languages, then a model.
- **A chat model** is optional, and it is used to clean up the text.

## Recognition

- **Translate to English** gives you English text from any language. This needs a speech model with translation.
- **Filter silence** skips the parts with no voice before transcription.
- **Remove filler words** takes out sounds such as "um" and "uh", with no chat model.
- **Dictionary** holds names and terms you say. Write `Parakeet = para keet` to correct a word that keeps coming out wrong.

## Clean up

- **Match the style to the program** writes for a chat, an email or a coding tool.
- **Read the text around the cursor** sends up to 1,024 characters on each side of the cursor to your chat model for context. A password field is never read, and words you speak into one are not sent to a model and stay out of History.
- **Correction word** is the word you say before a correction, such as "sorry".
- **Instructions** can be your own in place of the built-in ones. A result that keeps fewer than half of your words is not used.

## When something fails

If a transcription fails, choose **Try again** in History to transcribe the same recording. If the text cannot be inserted, it stays in History, ready to copy. With **Keep history** off, History holds the last text until the next dictation appears. **Test** beside the microphone in Settings records ten seconds and plays them back, and the sound stays on this device.

## Permissions

- **Your microphone** is used only while you dictate. Choose one in **Settings > Apps > Dictation**, or use the system's default.
- **Typing into your other programs** is how the text goes in.
- **A view over your other programs** shows while you speak.
- **The name of the program in front** is used to match the style of the text and to label each dictation in History.
- **The text around the cursor and your selection** go to your chat model and nowhere else. Your clipboard is read only to restore it after a paste.
- **Running in the background** keeps the key ready at any moment.

The sound stays in memory until the next text appears.
