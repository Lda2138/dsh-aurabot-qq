# Privacy and local data

This is a source-only snapshot with a new Git history. Production data and private research tooling are not included.

- Keep credentials, tokens, cookies and runtime configuration local.
- Keep conversations, memories, journals, images, audio caches and message receipts out of Git.
- No individual voice dataset, reference recording, cloned voice ID, speaker embedding, training checkpoint or retrieval index is distributed.
- Voice integrations are optional generic interfaces. Supply your own authorized services and assets.
- Included tests use synthetic identities and fixtures. Private conversation regression fixtures have been omitted.

The `.gitignore` is an additional guard. Review every staged file before publishing later changes.
