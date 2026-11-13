# Conversation rewind

User messages have an edit action, and assistant replies have a regeneration action. Edit the text, keep or remove existing attachments, and add images or files. Submit an unchanged input to send it again.

A revision preserves messages before the selected position and continues from the updated input. The original input, its old answer, and later messages leave the active context. Append-only history remains in the session log. Edit markers can put the original user input and its attachments back into the composer.

Images remain image content and files remain attachments. Their original data must still exist in the local attachment store.

Regeneration does not undo file changes, commands, or external service actions. The plugin does not read provider credentials, rewrite session files, or start a separate web server. Restart DSH after installation or upgrades. The plugin UI currently uses Chinese.

See the [English README](../README.en.md) for usage, compatibility, and development notes.
