# google-cms

Reading a Google Drive folder and a Google Calendar at build time, for static
site generators. This is the glossary; the traps live in
[`AGENTS.md`](AGENTS.md) and the usage in [`README.md`](README.md).

## Language

**Transport**:
The half of a resource that talks to Google and interprets nothing — it decides
what to ask for and hands back the raw payload.
_Avoid_: client, fetcher, service

**Normaliser**:
The half of a resource that turns a raw payload into what a page lays out. Pure:
no network, no clock, no environment, no locale.
_Avoid_: mapper, parser, transformer

**Page walk**:
Following `nextPageToken` until a listing is exhausted, or failing loudly rather
than truncating. One of the two ways this package can silently hand back wrong
data, and therefore a thing with a name.
_Avoid_: pagination, paging, page loop
