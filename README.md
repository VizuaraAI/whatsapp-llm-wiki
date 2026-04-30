# WhatsApp LLM Wiki

This is a minimal WhatsApp group memory system for the inference engineering workshop.

It connects to WhatsApp using the QR-code linked-device flow, ingests watched group messages, stores them locally, downloads shared resources, and regenerates Markdown wiki pages.

## Quick Start

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create your env file:

   ```bash
   cp .env.example .env
   ```

3. Start WhatsApp linking:

   ```bash
   npm run whatsapp
   ```

4. Scan the QR code:

   WhatsApp on phone -> Settings -> Linked Devices -> Link a Device.

5. Watch the terminal for group IDs. Put your workshop group JID into `.env`:

   ```bash
   WHATSAPP_GROUP_JIDS=1203630xxxxx@g.us
   ```

6. Restart:

   ```bash
   npm run whatsapp
   ```

7. The listener automatically updates the wiki every 20 ingested messages by default.

   You can also update the wiki manually at any time:

   ```bash
   npm run wiki:update
   ```

## View The Wiki Site

Run the local server:

```bash
npm run site
```

Then open:

```text
http://localhost:4173
```

Use the **Add resource** button to persist a resource. Metadata is stored in `data/manual-resources.json`, and uploaded files are stored in `data/manual-uploads/`. The daily sync merges those manual resources back into the generated site and Markdown wiki.

Production storage on Vercel uses Vercel Blob:

- uploaded files: `manual-uploads/*`
- resource metadata: `manual-resources/index.json`

That means people can click uploaded files from the deployed site and see/download them from Blob URLs. Vercel function disk is not used for persistence.

## Running Continuously

Keep this command running on the machine that owns the linked WhatsApp session:

```bash
npm run whatsapp
```

For a production-ish setup, run it inside a dedicated user account, VM, or container with only this project directory mounted.

## Import Old WhatsApp History

Export the group chat from WhatsApp, preferably "without media" first:

- iPhone: group info -> Export Chat -> Without Media.
- Android: group menu -> More -> Export chat -> Without media.

Put the exported `.txt` file anywhere on this machine, then run:

```bash
npm run import:whatsapp -- "/absolute/path/to/_chat.txt"
npm run wiki:update
```

The importer accepts common WhatsApp export formats like:

```text
30/04/26, 12:34 PM - Alice: message
[30/04/26, 12:34:56 PM] Alice: message
```

Imported messages are appended to `data/messages.jsonl` with a synthetic group ID of `historical-whatsapp-export@g.us`.

## Files

- `data/messages.jsonl`: append-only local message log.
- `data/media/`: downloaded files and media.
- `wiki/Home.md`: current wiki overview.
- `wiki/Important Discussions.md`: important workshop threads and resources.
- `auth/`: WhatsApp linked-device session credentials.

## Public Repo Privacy Notes

This repository is designed to keep source code public while keeping workshop data private.
The `.gitignore` excludes WhatsApp session credentials, raw chat logs, exported media,
generated wiki pages, generated static HTML, local Vercel metadata, QR codes, and manual
resource metadata. Regenerate those artifacts locally or in your deployment environment
after configuring `.env`.

## Recommended WhatsApp Setup

Use a dedicated workshop WhatsApp number. Add that number to the group as a visible participant, for example "Inference Wiki Bot", so members know the group is being archived and summarized.
