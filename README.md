### Overview
Syncs ST characters and chats with Letta agents and conversations.

Pastes ST system prompt into memory blocks/system prompt.

### Setup
Clone into SillyTavern/plugins.
Requires the matching extension.

Connect to custom OPenAI-compatible Chat Completion endpoint

- base url: http://localhost:5001/v1
- api key: your_letta_key
- Additional Parameters -> Include Request Headers -> LETTA_BASE_URL: http://localhost:8283 (or other location running letta if different from https://api.letta.com)