# Errors carry a message, not a code

The page walk fails in three distinguishable ways — a non-OK response, a
repeated `pageToken`, and the `maxPages` cap — and the tests currently tell them
apart by matching the message. A `code` on the thrown error would be sturdier
for the tests, but those errors escape `listFiles` and `listEvents`, so the code
would become public interface this package has to keep stable. Rejected: the
stated error policy is that a build-time tool fails loudly rather than
degrades, so nothing downstream is meant to branch on _why_ a listing could not
be read — and a machine-readable code invites exactly that.

## Consequences

The messages are the interface for a human, which is why they say what tripped
and what to do about it, and why each transport supplies its own sentence
explaining its own cap. Tests assert against message text, and rewording a
message is therefore a test-visible change rather than a free edit.

Worth reopening if a consumer ever needs to retry one failure and not the
others — a transient 503 versus a folder that stopped being shared is the case
that would make it real.
