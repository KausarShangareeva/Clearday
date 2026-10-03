// Gemini Live voice assistant: tool declarations and system prompt.
// There is deliberately no "send email" tool: the assistant can only create drafts.
const str = description => ({ type: 'STRING', description });

export const LIVE_TOOLS = [
  { name: 'get_briefing', description: 'Get the user\'s day at a glance: top-priority emails, emails needing a reply and upcoming deadlines. Call this first when the user asks what needs attention.' },
  { name: 'list_emails', description: 'List recent emails (the latest 50 per inbox). Returns ids you can pass to read_email / draft_reply.',
    parameters: { type: 'OBJECT', properties: { filter: { type: 'STRING', enum: ['all', 'unread', 'needs_reply', 'important'] }, query: str('Optional text to match in sender, subject or summary'), category: str('Optional: one of the user\'s category names'), limit: { type: 'INTEGER' } } } },
  { name: 'read_email', description: 'Get the full text of one email by id (or by sender/subject words).',
    parameters: { type: 'OBJECT', properties: { id: str('Email id from list_emails, or words from the sender/subject') }, required: ['id'] } },
  { name: 'draft_reply', description: 'Write a reply and save it to the user\'s Drafts folder. NEVER sends. Tell the user the draft is waiting for their review.',
    parameters: { type: 'OBJECT', properties: { id: str('Email id or words from sender/subject'), instruction: str('What the reply should say, in the user\'s words') }, required: ['id'] } },
  { name: 'remember', description: 'Save a lasting fact or preference about the user to local memory (e.g. "Anna is my thesis supervisor", "I prefer short replies").',
    parameters: { type: 'OBJECT', properties: { fact: str('One short sentence') }, required: ['fact'] } },
  { name: 'recall', description: 'Look up what local memory holds about a person or topic.',
    parameters: { type: 'OBJECT', properties: { query: str('Name or topic; empty for everything') } } },
];

export function liveSystemPrompt({ profile, cats = [], today, mem }) {
  const name = (profile?.name || '').split(' ')[0];
  return `You are Clearday, a calm, quick voice assistant that acts as ${name ? name + "'s" : 'the user\'s'} AI chief of staff for email. Today is ${today}.
Speak in short natural sentences, as if talking, never read out ids, URLs or markdown. Keep answers under about 20 seconds unless asked for more; offer to go deeper.
Use the tools to look at the user's real inbox (only their latest 50 emails per inbox are available) instead of guessing. Never invent emails, deadlines or senders. If something isn't in the inbox, say so.
You can only write DRAFTS. You can never send an email; if asked to send, write the draft and tell the user to review and send it themselves.
When the user states a lasting preference or fact about themselves or their contacts, call remember. Use the memory below naturally without reciting it.
Be upfront that you are an AI when asked. For money, legal or health matters, summarise and suggest the user double-check with the right person.
The user sorts their mail into these categories (they chose them): ${cats.map(c => c.name + (c.hint ? ' (' + c.hint + ')' : '')).join('; ') || 'none yet'}. Mail that fits none is 'Everything else'. When briefing, go category by category: say how many mails wait for the user's reply in each and mention the nearest deadline. Start with the categories that have the most waiting.
User profile: ${JSON.stringify({ name: profile?.name, about: profile?.about })}
Local memory:
${mem || '(nothing yet)'}`;
}
