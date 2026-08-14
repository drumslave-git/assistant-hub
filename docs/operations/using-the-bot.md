# Using the bot in chat

What people in a Telegram chat can actually do, and how the bot decides whether to
answer. This is the page to share with the people using the bot — not the operator.

## When the bot answers

| Chat | It answers |
| --- | --- |
| **Private chat** | Always |
| **Group / supergroup** | When you address it |

In a group, you address the bot by:

- **@mentioning** it;
- **replying** to one of its messages;
- sending a **command** targeted at it (`/something@thebotusername`);
- **calling it by name** — including its name written in another alphabet or
  grammatically inflected ("Ари, привет"). That case is settled by a language model,
  which has to identify and quote the word it read as the name, and confirm it, before
  the bot will answer.

Anything else in a group is treated as conversation between other people. The bot
still **reads** it — everything is mirrored into history and can be recalled later —
it just does not reply.

If the bot answers when nobody was talking to it, that is fixable: see
[Correcting it](#correcting-it) below.

## What it knows

| Source | Reach |
| --- | --- |
| The last 24 hours of this chat | Verbatim, in every reply |
| Everything older in this chat | Searchable — it can look up exact wording, a date range, a specific message, or a past topic by meaning |
| Durable facts about people | Remembered across chats and across months, once consolidated |
| Shared general knowledge | Definitions, rules and conventions, in every reply |
| Images, GIFs, videos, stickers | Described once by a model; the description then stands in for the picture in later turns |
| Voice messages | Transcribed, then treated exactly as if the words had been typed |

Reply chains matter to it: every history line is anchored by its Telegram message id
and a reply is marked as such, so "what did we decide about that" resolves to the
right thread rather than to whatever was said nearby.

## What it can do

Ask in plain language. There is no command syntax.

### Remember something

> "Remember that I'm allergic to peanuts."

It also saves things unprompted when you reveal something lastingly true about
yourself. Notes are merged into durable memory overnight, and the operator can review
and correct them on the Memory page.

It can be asked what it knows: "what do you remember about me?"

### Recall a past conversation

> "What did we decide about the invoice?"
> "When did we talk about the trip?"

It searches compressed summaries of each past day's topics **by meaning**, then reads
the actual original messages before answering. Which means it can find a subject even
when your question phrases it differently than the chat did.

### Set a reminder

> "Remind me in 5 minutes to check the oven."
> "Every weekday at 9, post the standup prompt."
> "Tomorrow at 18:00, remind us about the meeting."

One-off, daily and weekly schedules all work, and relative times ("in an hour",
"tonight", "next Monday") are resolved against the current time.

Anyone in the chat can create a task. You can list and read all of the chat's tasks —
but you can only **change or cancel the ones you created**. Reminders are delivered to
the chat they were created in.

Cancelling from the chat **removes** the task; there is no "pause it for now" from
here. Pausing is the operator's, on the `/tasks` page — and a paused task is one the
bot no longer knows about at all, so asking it about one gets you "no such task".

The delivered message is written fresh each time rather than replayed, so a daily
reminder does not read identically every day.

Asking for the same reminder twice does not give you two: the same wording for the
same time is treated as the one you already have. Same wording at a *different*
time is a second reminder, as it should be.

### Look something up

> "What's the latest on X?"

It searches the web and cites its sources. For anything current or specific to a named
site, it opens the page instead — see below.

### Read a link

> "https://example.com/article — what does this say?"

Share a URL and it reads the page with a real browser and answers from the content
rather than from memory. One page at a time; it cannot fetch files this way.

### Browse and download

> "Download the video on this page."
> "Check the live viewer count on <site>."
> "Find the PDF on their downloads page and send it."

This starts a background browsing session: a real browser navigates, clicks, fills
forms, reads live rendered values, and downloads files. It runs on its own and reports
back to the chat when it is done, so the bot will acknowledge and then go quiet for a
while.

Downloaded files are posted to the chat as they land, provided they are within the
size limit the operator configured. Larger files stay on the server.

**Downloading is restricted to the bot's configured owner.** Anyone can start a
browsing session; only the owner's sessions may download.

This is the bot's **only** way to reach the internet — searching, opening a link you
sent, reading a live value, and downloading all go through it. So anything web-shaped
takes the "I'm on it, back shortly" shape rather than an instant answer.

### Generate an image

> "Draw a watercolour of a lighthouse at dusk."

It generates the picture and sends it. It never sees its own output, so it will not
describe what it drew — it just tells you it is there. It cannot use this to reproduce
an existing photo; it draws something new.

### Voice

Send a voice message and it will be transcribed and answered like text. If the
operator has configured a speech endpoint, replies come back as voice messages too.

### Tell it a nickname

> "Everyone calls Alexandra 'Sasha'."

It records the nickname so it recognizes that name later. It identifies people by the
names it can already see in the conversation, never by internal ids.

## Correcting it

React to any of the bot's replies with 👍 or 👎. It posts a short menu of options; pick
one, or choose "Other" and reply with your own words.

Only the person who reacted can answer the menu — anyone else pressing a button gets a
private popup. The menu deletes itself once answered.

| Reaction | What happens |
| --- | --- |
| 👍 with an option | Recorded, and folded into what it learns about how you like to be answered |
| 👎 with an option | Same, plus it becomes part of the global corrections it applies to everyone |
| 👎 → **"Wasn't talking to you"** | The specific word it mistook for its name is filed as an exclusion, so it stops answering to that word |

Every answer also triggers the bot writing down its own account of why that exchange
went the way it did — which is what lets a complaint like "too long" turn into an
actual behavior change rather than a note nobody reads.

Preferences and corrections are applied from the next day, after the nightly job folds
them in.

**In a group, 👍/👎 reactions only reach the bot if it is a group administrator.** In
private chats they always do.

## Reply language

The bot replies in the language the operator configured for your chat — per group, or
per person for private chats — regardless of the language you write in. If nothing is
configured, it replies in English. Ask the operator to change it.

## When it will not answer

| Symptom | Reason |
| --- | --- |
| Silence in a group | It did not consider itself addressed. @mention it or reply to one of its messages |
| "Maintenance" notice | The operator has turned on maintenance mode. Only the owner gets normal replies until it is off |
| A reminder never arrived | Firing is paused during maintenance mode. It will deliver once maintenance ends |
| It says it could not do something | Take that literally. It is instructed never to claim it looked something up, saved something, or remembered something unless it actually did |

That last one is worth trusting: it is told that an action only counts when it actually
carries it out and it succeeds, and that saying "I'll remember that" without actually
saving is a false promise.

## Privacy, plainly

Everything said in a chat the bot is in is stored: the messages, the images (as
descriptions), the voice notes (as transcripts). The complete text of every exchange —
including what the bot was told about you and what it said back — is also written to
the operator's debug log. The operator can read all of it.
