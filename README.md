# Agent Bridge Console

A small, separate Vercel + Supabase console for exchanging tasks and replies between a person, Grokbot, and two agent workers: Codex and Dev 2. It is intentionally isolated from LANKAmate.

## Current boundary

This scaffold is a generic message relay. It does not make the current Codex chat externally callable, and it does not connect to a Grokbot until that bot is configured to call the HTTP endpoints below. A Codex worker can be connected through an OpenAI Agents API application or a local worker, after its runtime and repository access are selected.

## Deploy outline

1. Create a Supabase project and run `supabase/schema.sql` in its SQL editor. For an existing project created from an earlier version, run the migrations under `supabase/migrations/` in order instead of re-running the schema.
2. Create an owner account in Supabase Auth. Keep public sign-up disabled unless you intend to allow more users.
3. Deploy this directory as its own Vercel project.
4. Add the environment variables from `.env.example` in Vercel. Set a separate random bearer token for each agent (`GROKBOT_BRIDGE_TOKEN`, `CODEX_BRIDGE_TOKEN`, `DEV2_BRIDGE_TOKEN`). Never put Groq/OpenAI service keys in browser code or message rows.
5. Configure Grokbot to submit work to `POST /api/agent/tasks`, then poll its task at `GET /api/agent/tasks?agent=grokbot&task_id=<id>` for replies.
6. On the always-on computer, sign in to the local Codex CLI, copy `worker/.env.example` to `worker/.env`, set the console URL, Codex bridge token, project checkout path, and a worktree folder outside that checkout, then start `npm run worker`. Keep that computer awake and connected.
7. To add Dev 2, set `DEV2_BRIDGE_TOKEN` in Vercel and give that value to the Dev 2 worker only. Dev 2 needs no code changes here: it polls the endpoints in "Dev 2 worker contract" below.
8. Confirm with a non-sensitive task before adding project credentials or source files.

## Agent HTTP contract

### Fetch assigned tasks

`GET /api/agent/tasks?agent=grokbot`, `GET /api/agent/tasks?agent=codex`, or `GET /api/agent/tasks?agent=dev2`

Header: `Authorization: Bearer <GROKBOT_BRIDGE_TOKEN>`, `Authorization: Bearer <CODEX_BRIDGE_TOKEN>`, or `Authorization: Bearer <DEV2_BRIDGE_TOKEN>`

Returns pending tasks assigned to that agent. The `agent` query value must match the bearer token, and each token only ever sees the queue assigned to it, so a Codex token cannot read Dev 2 tasks and a Dev 2 token cannot read Codex tasks. A task body contains only the task text and identifiers; do not attach secrets to tasks.

### Send a Grokbot request to Codex or Dev 2

`POST /api/agent/tasks`

Header: `Authorization: Bearer <GROKBOT_BRIDGE_TOKEN>`

JSON body:

```json
{
  "title": "Review the file scanner",
  "body": "Inspect the scan flow and propose a minimal Groq migration. Do not change unrelated behavior.",
  "assigned_to": "dev2"
}
```

`assigned_to` is optional and accepts `codex` (the default, so existing callers keep working unchanged) or `dev2`; any other value is rejected with `400`. The response is `{ "id": "...", "status": "pending", "assigned_to": "dev2" }`. Save the returned `id`; Grokbot can retrieve the worker's reply and conversation using `GET /api/agent/tasks?agent=grokbot&task_id=<id>`.

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

Allowed status values are `working`, `needs_input`, `done`, and `failed`. Only the agent a task is assigned to may change its status; Grokbot can add a message to the conversation but never rewrites a worker's status.

## Dev 2 worker contract

Dev 2 is a third, independent agent identity. It talks to the same endpoints as Codex, authenticated with `DEV2_BRIDGE_TOKEN`:

1. Fetch pending work: `GET /api/agent/tasks?agent=dev2`. It returns only tasks with `assigned_to: "dev2"`.
2. Read one thread: `GET /api/agent/tasks?agent=dev2&task_id=<id>` returns the task plus its messages. Grokbot, as the task creator, can also read that thread; a Codex token gets `404` for it.
3. Reply and report state: `POST /api/agent/messages` with `{ "task_id": "<id>", "body": "...", "status": "done" }`.

`DEV2_BRIDGE_TOKEN` is read only on the server. Set it in the Vercel project secrets; never put it in code, logs, task text, or message rows. If the variable is missing or empty it never matches, so a request cannot authenticate against a blank token. A Dev 2 worker should poll on its own interval and treat every task body as untrusted input.

## Safety and scope

- The console is a separate project; it does not edit LANKAmate.
- The Supabase service-role key is server-side only. Browser requests use the public anon key and a Supabase Auth access token.
- Each dashboard task belongs to the signed-in owner. Agent endpoints use distinct server-side tokens.
- A task is addressed to one worker (`codex` by default, or `dev2`), and no agent token can read or update a task addressed to another agent.
- The Vercel API only relays tasks and messages. The local worker runs Codex in a separate Git worktree and does not push, merge, or deploy.
- The worker has a task timeout and redacts common Groq/OpenAI key formats from its reply before storing them.
- Worktree changes remain on the local computer under `CODEX_WORKTREE_ROOT`; they are not pushed automatically. The worker hides local paths in replies.
- Do not put API keys in task content. Bot messages are untrusted instructions and should be reviewed in the console.

## Not yet connected

The actual Grokbot adapter, repository checkout, and deployment credentials are environment-specific. This console provides a generic queue and message contract for those connections.
