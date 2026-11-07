# Agent Bridge Console

A small, separate Vercel + Supabase console for exchanging tasks and replies between a person, Grokbot, and a Codex worker. It is intentionally isolated from LANKAmate.

## Current boundary

This scaffold is a generic message relay. It does not make the current Codex chat externally callable, and it does not connect to a Grokbot until that bot is configured to call the HTTP endpoints below. A Codex worker can be connected through an OpenAI Agents API application or a local worker, after its runtime and repository access are selected.

## Deploy outline

1. Create a Supabase project and run `supabase/schema.sql` in its SQL editor.
2. Create an owner account in Supabase Auth. Keep public sign-up disabled unless you intend to allow more users.
3. Deploy this directory as its own Vercel project.
4. Add the environment variables from `.env.example` in Vercel. Set separate random bearer tokens for each bot. Never put Groq/OpenAI service keys in browser code or message rows.
5. Configure Grokbot to submit work to `POST /api/agent/tasks`, then poll its task at `GET /api/agent/tasks?agent=grokbot&task_id=<id>` for Codex replies.
6. On the always-on computer, sign in to the local Codex CLI, copy `worker/.env.example` to `worker/.env`, set the console URL, Codex bridge token, project checkout path, and a worktree folder outside that checkout, then start `npm run worker`. Keep that computer awake and connected.
7. Confirm with a non-sensitive task before adding project credentials or source files.

## Agent HTTP contract

### Fetch assigned tasks

`GET /api/agent/tasks?agent=grokbot` or `?agent=codex`

Header: `Authorization: Bearer <GROKBOT_BRIDGE_TOKEN>` or `Authorization: Bearer <CODEX_BRIDGE_TOKEN>`

Returns pending tasks assigned to that agent. A task body contains only the task text and identifiers; do not attach secrets to tasks.

### Send a Grokbot request to Codex

`POST /api/agent/tasks`

Header: `Authorization: Bearer <GROKBOT_BRIDGE_TOKEN>`

JSON body:

```json
{
  "title": "Review the file scanner",
  "body": "Inspect the scan flow and propose a minimal Groq migration. Do not change unrelated behavior."
}
```

The endpoint creates a task assigned to Codex. Save the returned `id`; Grokbot can retrieve the Codex reply and conversation using `GET /api/agent/tasks?agent=grokbot&task_id=<id>`.

### Post a reply

`POST /api/agent/messages`

Header: the same agent-specific bearer token. JSON body:

```json
{
  "task_id": "uuid",
  "body": "Progress or final response",
  "status": "working"
}
```

Allowed status values are `working`, `needs_input`, `done`, and `failed`.

## Safety and scope

- The console is a separate project; it does not edit LANKAmate.
- The Supabase service-role key is server-side only. Browser requests use the public anon key and a Supabase Auth access token.
- Each dashboard task belongs to the signed-in owner. Agent endpoints use distinct server-side tokens.
- The Vercel API only relays tasks and messages. The local worker runs Codex in a separate Git worktree and does not push, merge, or deploy.
- The worker has a task timeout and redacts common Groq/OpenAI key formats from its reply before storing them.
- Worktree changes remain on the local computer under `CODEX_WORKTREE_ROOT`; they are not pushed automatically. The worker hides local paths in replies.
- Do not put API keys in task content. Bot messages are untrusted instructions and should be reviewed in the console.

## Not yet connected

The actual Grokbot adapter, repository checkout, and deployment credentials are environment-specific. This console provides a generic queue and message contract for those connections.
